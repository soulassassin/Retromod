#!/usr/bin/env node
'use strict';

// RETROMOD Supabase admin CLI. Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local / env.
//
//   node scripts/supabase-admin.js migrate                  Copy data/catalog.json (or seed), orders and
//                                                           data/media photos into Supabase. Skips rows
//                                                           that already exist, so it is safe to re-run.
//   node scripts/supabase-admin.js add-staff <email>        Create a staff login (prompts for a password,
//                                                           or reads RETROMOD_STAFF_PASSWORD).
//   node scripts/supabase-admin.js set-password <email>     Reset a staff password (asks twice, then test-signs-in).
//   node scripts/supabase-admin.js remove-staff <email>    Revoke stock-manager access and delete the login.
//   node scripts/supabase-admin.js list-staff               Show who has access.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { loadLocalEnvFiles } = require('../server');
const { getSupabaseConfig, createSupabaseClient } = require('../lib/supabase-store');
const { normalizeProduct } = require('../lib/store');

const ROOT = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

function readJsonIfExists(p) {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

async function migrate(client) {
  const dataDir = path.resolve(process.env.RETROMOD_DATA_DIR || path.join(ROOT, 'data'));
  const catalog = readJsonIfExists(path.join(dataDir, 'catalog.json')) || readJsonIfExists(path.join(ROOT, 'data', 'seed-catalog.json'));
  const orders = readJsonIfExists(path.join(dataDir, 'orders.json')) || { orders: [] };

  const existingProducts = new Set((await client.request('GET', '/rest/v1/products?select=id')).map(r => r.id));
  const existingOrders = new Set((await client.request('GET', '/rest/v1/orders?select=order_ref')).map(r => r.order_ref));

  const mediaDir = path.join(dataDir, 'media');
  let uploaded = 0;
  if (fs.existsSync(mediaDir)) {
    for (const name of fs.readdirSync(mediaDir)) {
      if (!/^[a-z0-9][a-z0-9._-]*\.(?:jpg|jpeg|png|webp|gif)$/i.test(name)) continue;
      const ext = name.split('.').pop().toLowerCase();
      const type = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[ext];
      await client.request('POST', `/storage/v1/object/media/${encodeURIComponent(name)}`, {
        body: fs.readFileSync(path.join(mediaDir, name)),
        raw: true,
        headers: { 'Content-Type': type, 'x-upsert': 'true' }
      });
      uploaded += 1;
    }
  }

  const productInserts = (catalog.products || [])
    .map((p, idx) => ({ id: p.id, data: normalizeProduct(p), sort_order: idx }))
    .filter(p => !existingProducts.has(p.id));
  const orderInserts = (orders.orders || [])
    .filter(o => o && o.orderRef && !existingOrders.has(o.orderRef))
    .map(o => ({ order_ref: o.orderRef, data: o }));

  if (productInserts.length || orderInserts.length) {
    await client.request('POST', '/rest/v1/rpc/apply_changes', {
      body: { changes: { product_inserts: productInserts, order_inserts: orderInserts } }
    });
  }

  console.log(`\n  Migrated ${productInserts.length} products, ${orderInserts.length} orders, ${uploaded} photos.`);
  console.log(`  Skipped ${existingProducts.size} products / ${existingOrders.size} orders already in Supabase.\n`);
}

// Reads a password showing one * per character. Handles backspace, Ctrl+C and Windows \r\n.
function askHidden(question) {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    // Not an interactive terminal: read a plain line.
    return new Promise(resolve => {
      const rl = readline.createInterface({ input: stdin, output: process.stdout, terminal: false });
      process.stdout.write(question);
      rl.once('line', line => { rl.close(); resolve(line.replace(/\r$/, '')); });
    });
  }
  return new Promise(resolve => {
    let value = '';
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130); }
        if (ch === '\u0008' || ch === '\u007f') {
          if (value.length) { value = value.slice(0, -1); process.stdout.write('\b \b'); }
          continue;
        }
        if (ch < ' ') continue; // ignore other control keys
        value += ch;
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

async function askNewPassword(email) {
  if (process.env.RETROMOD_STAFF_PASSWORD) return process.env.RETROMOD_STAFF_PASSWORD;
  const first = await askHidden(`  New password for ${email} (min 10 chars): `);
  if (!first || first.length < 10) fail('Password must be at least 10 characters.');
  const second = await askHidden('  Type it again to confirm: ');
  if (first !== second) fail('The two passwords did not match. Nothing was changed - please try again.');
  return first;
}

// Signs in exactly like the /admin page does, to prove the password works.
async function verifyLogin(config, email, password) {
  const res = await fetch(`${config.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: config.anonKey || config.serviceKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  if (res.ok) {
    console.log(`  Checked: ${email} can sign in with this password.`);
  } else {
    console.log(`  Warning: test sign-in failed (${res.status}). Run staff:password again.`);
  }
}

async function findUserByEmail(client, email) {
  for (let page = 1; page < 50; page++) {
    const res = await client.request('GET', `/auth/v1/admin/users?page=${page}&per_page=200`);
    const users = (res && res.users) || [];
    const hit = users.find(u => String(u.email || '').toLowerCase() === email);
    if (hit) return hit;
    if (users.length < 200) return null;
  }
  return null;
}

async function setPassword(client, config, emailArg) {
  const email = String(emailArg || '').trim().toLowerCase();
  if (!email) fail('Usage: set-password <email>');
  const user = await findUserByEmail(client, email);
  if (!user) fail(`No login found for ${email}. Create it with: npm run staff:add -- ${email}`);
  const password = await askNewPassword(email);
  await client.request('PUT', `/auth/v1/admin/users/${user.id}`, { body: { password } });
  console.log(`  Password updated for ${email}`);
  await verifyLogin(config, email, password);
  console.log('');
}

async function addStaff(client, config, emailArg) {
  const email = String(emailArg || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Usage: add-staff <email>');

  let user = await findUserByEmail(client, email);
  if (!user) {
    const password = await askNewPassword(email);
    user = await client.request('POST', '/auth/v1/admin/users', {
      body: { email, password, email_confirm: true }
    });
    console.log(`  Created login for ${email}`);
    await verifyLogin(config, email, password);
  } else {
    console.log(`  ${email} already has a login; granting access.`);
  }

  await client.request('POST', '/rest/v1/staff', {
    body: { user_id: user.id, email },
    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }
  });
  console.log(`  ${email} can now sign in at /admin\n`);
}

async function removeStaff(client, emailArg) {
  const email = String(emailArg || '').trim().toLowerCase();
  if (!email) fail('Usage: remove-staff <email>');
  const user = await findUserByEmail(client, email);
  if (!user) fail(`No login found for ${email}`);
  await client.request('DELETE', `/auth/v1/admin/users/${user.id}`);
  console.log(`  Removed ${email} (login deleted, access revoked)\n`);
}

async function listStaff(client) {
  const rows = await client.request('GET', '/rest/v1/staff?select=email,created_at&order=created_at.asc');
  if (!rows.length) {
    console.log('\n  No staff yet. Add one with: npm run staff:add -- you@example.com\n');
    return;
  }
  console.log('');
  for (const r of rows) console.log(`  ${r.email}  (since ${String(r.created_at).slice(0, 10)})`);
  console.log('');
}

async function main() {
  loadLocalEnvFiles(ROOT);
  const config = getSupabaseConfig();
  if (!config) fail('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local first (see .env.example).');
  const client = createSupabaseClient(config);
  const [cmd, arg] = process.argv.slice(2);

  switch (cmd) {
    case 'migrate': return migrate(client);
    case 'add-staff': return addStaff(client, config, arg);
    case 'set-password': return setPassword(client, config, arg);
    case 'remove-staff': return removeStaff(client, arg);
    case 'list-staff': return listStaff(client);
    default:
      fail('Commands: migrate | add-staff <email> | set-password <email> | remove-staff <email> | list-staff');
  }
}

main().catch(err => fail(err.message || String(err)));
