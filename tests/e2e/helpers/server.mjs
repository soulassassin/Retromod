import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
export const DEFAULT_ADMIN_PASSWORD = 'retromod-e2e-admin-2026';

const activeServers = new Set();
let hooksRegistered = false;

function killProcessTreeSync(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      });
    } catch {
      // Process may already have exited
    }
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Ignore
    }
  }
}

async function killProcessTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exitPromise = new Promise((resolve) => {
    child.once('exit', () => resolve());
  });
  try {
    child.kill('SIGTERM');
  } catch {
    // Ignore
  }
  const exitedGracefully = await Promise.race([
    exitPromise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 1500))
  ]);
  if (!exitedGracefully && child.pid) {
    if (process.platform === 'win32') {
      try {
        await execFileAsync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true
        });
      } catch {
        // Ignore if already exited
      }
    } else {
      try {
        child.kill('SIGKILL');
      } catch {
        // Ignore
      }
    }
    await Promise.race([
      exitPromise,
      new Promise((resolve) => setTimeout(resolve, 2000))
    ]);
  }
}

function removeDirSafe(dirPath) {
  if (!dirPath) return;
  try {
    fs.rmSync(dirPath, {
      recursive: true,
      force: true,
      maxRetries: 6,
      retryDelay: 120
    });
  } catch {
    // Best-effort cleanup
  }
}

function registerCleanupHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;

  const cleanupAllSync = () => {
    for (const entry of activeServers) {
      if (entry.child && entry.child.exitCode === null && entry.child.signalCode === null) {
        killProcessTreeSync(entry.child.pid);
      }
      if (entry.cleanupDataDir) {
        removeDirSafe(entry.dataDir);
      }
    }
    activeServers.clear();
  };

  process.once('exit', cleanupAllSync);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => {
      cleanupAllSync();
      process.exit(130);
    });
  }
}

export async function getFreePort(host = '127.0.0.1') {
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = await new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.unref();
      srv.on('error', reject);
      srv.listen(0, host, () => {
        const addr = srv.address();
        const chosen = typeof addr === 'object' && addr ? addr.port : 0;
        srv.close((err) => {
          if (err) return reject(err);
          resolve(chosen);
        });
      });
    });
    if (port && port !== 3000) {
      return port;
    }
  }
  throw new Error('Failed to allocate a non-zero, non-3000 ephemeral port');
}

export async function startServer(options = {}) {
  registerCleanupHooks();

  const port = options.port ?? (await getFreePort('127.0.0.1'));
  if (!port || port === 3000) {
    throw new Error(`Refusing unsafe port: ${port}`);
  }

  const ownDataDir = !options.dataDir;
  const dataDir = options.dataDir
    ? path.resolve(options.dataDir)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'retromod-e2e-'));
  const cleanupDataDir = options.cleanupDataDir ?? ownDataDir;
  const adminPassword = options.adminPassword ?? DEFAULT_ADMIN_PASSWORD;
  const allowHosts = options.allowHosts ?? '127.0.0.1';
  const healthPath = options.healthPath ?? '/api/health';
  const timeoutMs = options.timeoutMs ?? 15000;
  const entryScript = options.scriptPath ?? path.join(REPO_ROOT, 'server.js');

  const env = {
    ...process.env,
    PORT: String(port),
    RETROMOD_DATA_DIR: dataDir,
    RETROMOD_ADMIN_PASSWORD: adminPassword,
    RETROMOD_IMPORT_ALLOW_HOSTS: allowHosts,
    NODE_ENV: 'test',
    ...(options.env || {})
  };

  const child = spawn(process.execPath, [entryScript], {
    cwd: REPO_ROOT,
    env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const logs = { stdout: '', stderr: '' };
  child.stdout?.on('data', (chunk) => {
    logs.stdout += chunk.toString();
    if (logs.stdout.length > 16384) logs.stdout = logs.stdout.slice(-16384);
  });
  child.stderr?.on('data', (chunk) => {
    logs.stderr += chunk.toString();
    if (logs.stderr.length > 16384) logs.stderr = logs.stderr.slice(-16384);
  });

  const entry = { child, dataDir, cleanupDataDir };
  activeServers.add(entry);

  const baseUrl = `http://127.0.0.1:${port}`;
  let exitedEarly = false;
  let exitInfo = null;
  child.once('exit', (code, signal) => {
    exitedEarly = true;
    exitInfo = { code, signal };
  });

  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  try {
    while (Date.now() < deadline) {
      if (exitedEarly) {
        throw new Error(
          `server.js exited early (code=${exitInfo?.code}, signal=${exitInfo?.signal}).\nSTDOUT:\n${logs.stdout}\nSTDERR:\n${logs.stderr}`
        );
      }
      try {
        const res = await fetch(`${baseUrl}${healthPath}`, {
          signal: AbortSignal.timeout(1000)
        });
        if (options.acceptAnyHttp || (res.status >= 200 && res.status < 400)) {
          return {
            baseUrl,
            port,
            dataDir,
            adminPassword,
            pid: child.pid,
            logs,
            async stop({ removeDataDir = cleanupDataDir } = {}) {
              activeServers.delete(entry);
              await killProcessTree(child);
              if (removeDataDir) {
                removeDirSafe(dataDir);
              }
            }
          };
        }
        lastError = new Error(`Health check ${healthPath} returned HTTP ${res.status}`);
      } catch (err) {
        lastError = err;
      }
      await new Promise((r) => setTimeout(r, 75));
    }
    throw new Error(
      `Timed out waiting for ${baseUrl}${healthPath} after ${timeoutMs}ms. Last error: ${lastError?.message}\nSTDOUT:\n${logs.stdout}\nSTDERR:\n${logs.stderr}`
    );
  } catch (err) {
    activeServers.delete(entry);
    await killProcessTree(child);
    if (cleanupDataDir) removeDirSafe(dataDir);
    throw err;
  }
}

export async function cleanupAllServers() {
  for (const entry of [...activeServers]) {
    activeServers.delete(entry);
    await killProcessTree(entry.child);
    if (entry.cleanupDataDir) removeDirSafe(entry.dataDir);
  }
}
