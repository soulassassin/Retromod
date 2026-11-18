'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createSupabaseStore, ConflictError } = require('../../lib/supabase-store');
const { createSupabaseAuthProvider } = require('../../lib/auth-providers');

const CONFIG = { url: 'https://example.supabase.co', serviceKey: 'service', anonKey: 'anon' };

function product(id, extra = {}) {
  return { id, title: id.toUpperCase(), category: 'audio', price: 1000, quantity: 1, status: 'available', ...extra };
}

function fakeClient({ products = [], orders = [], conflictsBeforeSuccess = 0 } = {}) {
  const db = {
    products: products.map((p, i) => ({ id: p.id, data: p, rev: 1, sort_order: i })),
    orders: orders.map(o => ({ order_ref: o.orderRef, data: o, rev: 1 }))
  };
  const calls = [];
  let conflicts = conflictsBeforeSuccess;
  return {
    db,
    calls,
    async request(method, pathname, opts = {}) {
      calls.push({ method, pathname, body: opts.body });
      if (method === 'GET' && pathname.startsWith('/rest/v1/products')) {
        const m = /id=eq\.([^&]+)/.exec(pathname);
        return m ? db.products.filter(r => r.id === decodeURIComponent(m[1])) : db.products.slice();
      }
      if (method === 'GET' && pathname.startsWith('/rest/v1/orders')) return db.orders.slice();
      if (method === 'POST' && pathname === '/rest/v1/rpc/apply_changes') {
        if (conflicts > 0) {
          conflicts -= 1;
          throw new ConflictError('retromod_conflict');
        }
        const c = opts.body.changes;
        for (const d of c.product_deletes) db.products = db.products.filter(r => r.id !== d.id);
        for (const u of c.product_updates) {
          const row = db.products.find(r => r.id === u.id);
          row.data = u.data;
          row.rev += 1;
        }
        for (const ins of c.product_inserts) db.products.push({ id: ins.id, data: ins.data, rev: 1, sort_order: ins.sort_order });
        for (const ins of c.order_inserts) db.orders.push({ order_ref: ins.order_ref, data: ins.data, rev: 1 });
        return null;
      }
      if (method === 'DELETE' && pathname.startsWith('/storage/v1/object/media')) return [];
      throw new Error(`Unexpected request ${method} ${pathname}`);
    }
  };
}

describe('Supabase store change sets', () => {
  it('reads products as a normalized catalog with stats', async () => {
    const client = fakeClient({ products: [product('a'), product('b', { status: 'sold', quantity: 0 })] });
    const store = createSupabaseStore({ config: CONFIG, client });
    const cat = await store.getCatalog();
    assert.equal(cat.products.length, 2);
    assert.equal(cat.stats.soldCount, 1);
    assert.equal((await store.getProductById('b')).status, 'sold');
    assert.equal(await store.getProductById('zzz'), null);
  });

  it('sends only changed rows: inserts, updates with rev, and deletes', async () => {
    const client = fakeClient({ products: [product('a'), product('b'), product('c')] });
    const store = createSupabaseStore({ config: CONFIG, client });

    await store.withTransaction(({ catalog }) => {
      catalog.products = catalog.products.filter(p => p.id !== 'b');
      catalog.products[0].price = 2500;
      catalog.products.push(product('d'));
      return { saveCatalog: true, result: null };
    });

    const rpc = client.calls.find(c => c.pathname === '/rest/v1/rpc/apply_changes').body.changes;
    assert.deepEqual(rpc.product_deletes, [{ id: 'b', rev: 1 }]);
    assert.equal(rpc.product_updates.length, 1);
    assert.equal(rpc.product_updates[0].id, 'a');
    assert.equal(rpc.product_updates[0].rev, 1);
    assert.equal(rpc.product_updates[0].data.price, 2500);
    assert.equal(rpc.product_inserts.length, 1);
    assert.equal(rpc.product_inserts[0].id, 'd');
    assert.equal(rpc.product_inserts[0].sort_order, 3);
    assert.deepEqual(client.db.products.map(r => r.id), ['a', 'c', 'd']);
  });

  it('skips the RPC entirely when nothing changed', async () => {
    const client = fakeClient({ products: [product('a')] });
    const store = createSupabaseStore({ config: CONFIG, client });
    const out = await store.withTransaction(() => ({ saveCatalog: true, result: 'ok' }));
    assert.equal(out, 'ok');
    assert.equal(client.calls.some(c => c.pathname === '/rest/v1/rpc/apply_changes'), false);
  });

  it('re-runs the transaction on an optimistic-lock conflict', async () => {
    const client = fakeClient({ products: [product('a')], conflictsBeforeSuccess: 2 });
    const store = createSupabaseStore({ config: CONFIG, client });
    let runs = 0;
    await store.withTransaction(({ catalog }) => {
      runs += 1;
      catalog.products[0].quantity = 0;
      return { saveCatalog: true, result: null };
    });
    assert.equal(runs, 3);
    assert.equal(client.db.products[0].data.status, 'sold');
  });

  it('gives up with a friendly 409 after repeated conflicts', async () => {
    const client = fakeClient({ products: [product('a')], conflictsBeforeSuccess: 99 });
    const store = createSupabaseStore({ config: CONFIG, client });
    await assert.rejects(
      store.withTransaction(({ catalog }) => {
        catalog.products[0].price = 1;
        return { saveCatalog: true, result: null };
      }),
      err => err.status === 409
    );
  });

  it('inserts new orders and exposes uploadMedia to the importer', async () => {
    const client = fakeClient({ products: [product('a')] });
    const store = createSupabaseStore({ config: CONFIG, client });
    await store.withTransaction(({ orders, writeMedia }) => {
      assert.equal(typeof writeMedia, 'function');
      orders.orders.push({ orderRef: 'RM-1', status: 'pending' });
      return { saveOrders: true, result: null };
    });
    assert.equal(client.db.orders.length, 1);
  });
});

describe('Supabase auth provider', () => {
  function fakeFetch({ staff = true, loginOk = true } = {}) {
    return async (url, opts = {}) => {
      const u = new URL(url);
      const json = body => ({ ok: true, status: 200, json: async () => body });
      if (u.pathname === '/auth/v1/token' && u.searchParams.get('grant_type') === 'password') {
        if (!loginOk) return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) };
        return json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, user: { id: 'u1', email: 'staff@retromod.test' } });
      }
      if (u.pathname === '/auth/v1/token' && u.searchParams.get('grant_type') === 'refresh_token') {
        return json({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 });
      }
      if (u.pathname === '/auth/v1/user') {
        const token = (opts.headers.Authorization || '').replace('Bearer ', '');
        if (token === 'at-1' || token === 'at-2') return json({ id: 'u1', email: 'staff@retromod.test' });
        return { ok: false, status: 401, json: async () => ({}) };
      }
      if (u.pathname === '/rest/v1/staff') return json(staff ? [{ user_id: 'u1' }] : []);
      throw new Error(`unexpected ${url}`);
    };
  }
  const req = cookie => ({ headers: cookie ? { cookie } : {}, socket: {} });

  it('logs staff in and sets httpOnly token cookies', async () => {
    const provider = createSupabaseAuthProvider({ config: CONFIG, fetchImpl: fakeFetch() });
    const out = await provider.login(req(), { email: 'Staff@Retromod.test', password: 'pw' });
    assert.equal(out.ok, true);
    assert.equal(out.user.email, 'staff@retromod.test');
    assert.equal(out.cookies.length, 2);
    assert.ok(out.cookies.every(c => c.includes('HttpOnly') && c.includes('SameSite=Strict')));
  });

  it('rejects valid accounts that are not on the staff allowlist', async () => {
    const provider = createSupabaseAuthProvider({ config: CONFIG, fetchImpl: fakeFetch({ staff: false }) });
    const out = await provider.login(req(), { email: 'someone@x.test', password: 'pw' });
    assert.equal(out.ok, false);
    assert.equal(out.status, 403);
  });

  it('rejects wrong passwords and malformed input', async () => {
    const provider = createSupabaseAuthProvider({ config: CONFIG, fetchImpl: fakeFetch({ loginOk: false }) });
    assert.equal((await provider.login(req(), { email: 'a@b.co', password: 'bad' })).status, 401);
    assert.equal((await provider.login(req(), { email: 'not-an-email', password: 'x' })).status, 400);
  });

  it('accepts a valid access token and refreshes an expired one', async () => {
    const provider = createSupabaseAuthProvider({ config: CONFIG, fetchImpl: fakeFetch() });
    const live = await provider.getSession(req('retromod_at=at-1'));
    assert.equal(live.session.user.id, 'u1');
    assert.equal(live.cookies.length, 0);

    const refreshed = await provider.getSession(req('retromod_at=expired; retromod_rt=rt-1'));
    assert.equal(refreshed.session.user.id, 'u1');
    assert.ok(refreshed.cookies.some(c => c.startsWith('retromod_at=at-2')));

    const none = await provider.getSession(req(''));
    assert.equal(none.session, null);
  });
});
