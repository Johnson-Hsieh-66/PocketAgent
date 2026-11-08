import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = value => createHash('sha256').update(value).digest('hex');
const idPattern = /^[a-zA-Z0-9_-]{1,80}$/;
export const inside = (parent, target) => {
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const relative = path.relative(normalize(parent), normalize(target));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};
export function validId(value) { return typeof value === 'string' && idPattern.test(value); }
async function runtimeDirectory(value) {
  const directory = path.resolve(value || process.env.POCKETAGENT_DATA_DIR || path.join(process.env.LOCALAPPDATA || '', 'PocketAgent'));
  if (inside(sourceRoot, directory)) throw new Error('DEPLOY_RUNTIME_INSIDE_CHECKOUT');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const resolved = await realpath(directory);
  if (inside(await realpath(sourceRoot), resolved)) throw new Error('DEPLOY_RUNTIME_INSIDE_CHECKOUT');
  return resolved;
}
export async function releaseDirectory(runtime, id) {
  if (!validId(id)) throw new Error('DEPLOY_INVALID_RELEASE');
  const base = await realpath(path.join(runtime, 'releases'));
  const directory = await realpath(path.join(base, id));
  if (!inside(base, directory) || directory === base) throw new Error('DEPLOY_RELEASE_OUTSIDE_RUNTIME');
  return directory;
}
async function inventory(directory) {
  const paths = [];
  async function walk(prefix = '') {
    for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
      const relative = path.posix.join(prefix.replaceAll('\\', '/'), entry.name);
      const target = path.join(directory, relative);
      if (entry.isSymbolicLink()) {
        const resolved = await realpath(target);
        if (!inside(directory, resolved)) throw new Error('DEPLOY_RELEASE_LINK_ESCAPE');
        // npm executable shims are not loaded by the running server.
        if (relative.startsWith('node_modules/.bin/')) continue;
        throw new Error('DEPLOY_RELEASE_LINK_UNSUPPORTED');
      }
      if (entry.isDirectory()) await walk(relative);
      else if (entry.isFile() && relative !== 'release-manifest.json') paths.push(relative);
    }
  }
  await walk();
  const files = new Array(paths.length);
  let next = 0;
  let failure;
  // Bound open/read buffers without weakening the full inventory or reusing a
  // previous verification. Drain in-flight reads before reporting any failure.
  await Promise.all(Array.from({ length: Math.min(4, paths.length) }, async () => {
    while (!failure) {
      const index = next++;
      if (index >= paths.length) return;
      try {
        const contents = await readFile(path.join(directory, paths[index]));
        files[index] = { path: paths[index], bytes: contents.length, sha256: digest(contents) };
      } catch (error) { failure = error; }
    }
  }));
  if (failure) throw failure;
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
async function copyTree(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('DEPLOY_SOURCE_LINK_UNSUPPORTED');
    if (entry.isDirectory()) await copyTree(path.join(from, entry.name), path.join(to, entry.name));
    else if (entry.isFile()) await copyFile(path.join(from, entry.name), path.join(to, entry.name));
  }
}
export async function workerFingerprint(directory) {
  const entry = 'dist/server/src/server/worker.js';
  const seen = new Set(); const hashes = [];
  async function visit(relative) {
    if (seen.has(relative)) return;
    seen.add(relative);
    const target = path.resolve(directory, relative);
    if (!inside(directory, target)) throw new Error('DEPLOY_WORKER_IMPORT_ESCAPE');
    const content = await readFile(target, 'utf8');
    hashes.push(relative + ':' + digest(content));
    for (const match of content.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
      await visit(dependency);
    }
  }
  await visit(entry);
  return digest(hashes.sort().join('\n'));
}
export async function verifyRelease(runtime, id) {
  const directory = await releaseDirectory(runtime, id);
  const manifest = JSON.parse(await readFile(path.join(directory, 'release-manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.releaseId !== id || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('DEPLOY_INVALID_MANIFEST');
  const actual = await inventory(directory);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error('DEPLOY_INTEGRITY_FAILED');
  if (await workerFingerprint(directory) !== manifest.workerFingerprint) throw new Error('DEPLOY_INTEGRITY_FAILED');
  const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  if (pkg.name !== 'pocketagent') throw new Error('DEPLOY_INVALID_RELEASE');
  return { directory, manifest };
}
export async function workerCompatible(runtime, id) {
  const candidate = await verifyRelease(runtime, id);
  const pin = path.join(runtime, 'pinned-release.json');
  if (!existsSync(pin)) return true;
  const current = JSON.parse(await readFile(pin, 'utf8'));
  if (current.schemaVersion !== 1 || !validId(current.releaseId)) throw new Error('DEPLOY_INVALID_MANIFEST');
  const pinned = await verifyRelease(runtime, current.releaseId);
  return candidate.manifest.workerFingerprint === pinned.manifest.workerFingerprint;
}
function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, shell: false, stdio: 'inherit' });
    child.once('error', () => reject(new Error('DEPLOY_COMMAND_FAILED')));
    child.once('close', code => code === 0 ? resolve() : reject(new Error('DEPLOY_CHECK_FAILED')));
  });
}
function npmCommand() {
  const npm = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(npm)) throw new Error('DEPLOY_NPM_NOT_FOUND');
  return npm;
}
export async function prepareRelease(runtime, { runCommand = run, checkout = sourceRoot } = {}) {
  const serviceRecord = path.join(runtime, 'service.json');
  if (!existsSync(path.join(runtime, 'active-release.json')) && existsSync(serviceRecord)) {
    const record = JSON.parse(await readFile(serviceRecord, 'utf8'));
    if (Number.isSafeInteger(record.pid) && record.pid > 0 && typeof record.entrypoint === 'string' && inside(checkout, path.resolve(record.entrypoint))) {
      let alive = false;
      try { process.kill(record.pid, 0); alive = true; } catch (error) { if (error.code !== 'ESRCH') alive = true; }
      if (alive) throw new Error('DEPLOY_LEGACY_SERVICE_RUNNING');
    }
  }
  const npm = npmCommand();
  // The checkout is build input. Running services load their own immutable release.
  const gates = [
    ['protocol:generate', 'DEPLOY_PREPARE_PROTOCOL_FAILED'],
    ['typecheck', 'DEPLOY_PREPARE_TYPECHECK_FAILED'],
    ['test', 'DEPLOY_PREPARE_TESTS_FAILED'],
    ['build', 'DEPLOY_PREPARE_BUILD_FAILED'],
    ['secret:check', 'DEPLOY_PREPARE_SECRET_CHECK_FAILED'],
  ];
  for (const [task, code] of gates) {
    try { await runCommand(process.execPath, [npm, 'run', task], checkout); }
    catch { throw new Error(code); }
  }
  const id = 'r-' + new Date().toISOString().replace(/[-:.]/g, '') + '-' + randomBytes(4).toString('hex');
  const directory = path.join(runtime, 'releases', id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const name of ['package.json', 'package-lock.json']) await copyFile(path.join(checkout, name), path.join(directory, name));
  await copyFile(path.join(checkout, 'LICENSE'), path.join(directory, 'LICENSE'));
  await mkdir(path.join(directory, 'scripts'));
  await copyFile(path.join(checkout, 'scripts', 'release.mjs'), path.join(directory, 'scripts', 'release.mjs'));
  await copyTree(path.join(checkout, 'dist'), path.join(directory, 'dist'));
  try { await runCommand(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], directory); }
  catch { throw new Error('DEPLOY_PREPARE_INSTALL_FAILED'); }
  const manifest = { schemaVersion: 1, releaseId: id, createdAt: new Date().toISOString(), workerFingerprint: await workerFingerprint(directory), files: await inventory(directory) };
  await writeFile(path.join(directory, 'release-manifest.json'), JSON.stringify(manifest) + '\n', { mode: 0o600, flag: 'wx' });
  await verifyRelease(runtime, id);
  return id;
}
async function httpProbe(origin, releaseId) {
  const get = route => fetch(origin + route, { signal: AbortSignal.timeout(3000), redirect: 'error' });
  try {
    const auth = await get('/api/auth'); const access = await auth.json();
    const page = await get('/'); const html = await page.text();
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g)].map(match => match[1]);
    let assetsReady = assets.length > 0;
    for (const asset of assets) {
      const response = await get(asset); const content = await response.text();
      const type = response.headers.get('content-type') || '';
      assetsReady &&= response.ok && (asset.endsWith('.js') ? /javascript/.test(type) : /css/.test(type)) && !content.trimStart().startsWith('<!doctype');
    }
    const releaseMatches = page.headers.get('x-pocketagent-release') === releaseId;
    return { httpReady: auth.ok && typeof access.authenticated === 'boolean' && page.ok, assetsReady, releaseMatches };
  } catch { return { httpReady: false, assetsReady: false, releaseMatches: false }; }
}
export async function releaseStatus(runtime, id) {
  const saved = JSON.parse(await readFile(path.join(runtime, 'config.json'), 'utf8'));
  const port = Number(process.env.POCKETAGENT_PORT || saved.port || 47831);
  const host = process.env.POCKETAGENT_HOST || saved.host || 'private';
  const { isAllowedHost } = await import(pathToFileURL(path.join(sourceRoot, 'dist/server/src/server/config.js')).href);
  if (!isAllowedHost(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('DEPLOY_INVALID_CONFIG');
  const { discoverAddresses } = await import(pathToFileURL(path.join(sourceRoot, 'dist/server/src/server/network.js')).href);
  const addresses = discoverAddresses(host);
  if (!id) { const active = JSON.parse(await readFile(path.join(runtime, 'active-release.json'), 'utf8')); id = active.releaseId; }
  const checks = await Promise.all(addresses.map(address => httpProbe('http://' + address + ':' + port, id)));
  const result = {
    httpReady: checks.length > 0 && checks.every(check => check.httpReady),
    assetsReady: checks.length > 0 && checks.every(check => check.assetsReady),
    releaseMatches: checks.length > 0 && checks.every(check => check.releaseMatches),
    workerReady: false, codexReady: false,
  };
  try {
    const { WorkerClient } = await import(pathToFileURL(path.join(sourceRoot, 'dist/server/src/server/worker-client.js')).href);
    const client = new WorkerClient({ dataDir: runtime });
    try {
      await client.connect();
      result.workerReady = true;
      result.codexReady = client.status.codex === 'ready';
      result.generation = client.status.generation;
      result.activeTurnCount = client.activeTurnCount;
      result.pendingRequestCount = client.pendingRequests.length;
    } finally { await client.close(); }
  } catch { /* Status output must never expose paths, tokens or raw transport errors. */ }
  return result;
}
async function maintenance(runtime, release) {
  const { WorkerClient } = await import(pathToFileURL(path.join(sourceRoot, 'dist/server/src/server/worker-client.js')).href);
  const client = new WorkerClient({ dataDir: runtime });
  try {
    await client.connect();
    if (release) { await client.endMaintenance(); return true; }
    return await client.beginMaintenanceIfIdle();
  } finally { await client.close(); }
}
async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (!['prepare', 'verify', 'worker-compatible', 'status', 'maintenance', 'maintenance-release'].includes(action)) throw new Error('DEPLOY_INVALID_ARGUMENTS');
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!['--data-dir', '--release-id'].includes(args[index]) || !args[index + 1]) throw new Error('DEPLOY_INVALID_ARGUMENTS');
    options[args[index]] = args[index + 1];
  }
  const runtime = await runtimeDirectory(options['--data-dir']);
  const id = options['--release-id'];
  if (action === 'prepare') console.log(JSON.stringify({ schemaVersion: 1, releaseId: await prepareRelease(runtime) }));
  else if (action === 'verify') { await verifyRelease(runtime, id); console.log(JSON.stringify({ verified: true })); }
  else if (action === 'worker-compatible') {
    const compatible = await workerCompatible(runtime, id);
    console.log(JSON.stringify({ compatible, code: compatible ? 'DEPLOY_WORKER_COMPATIBLE' : 'DEPLOY_WORKER_UPDATE_REQUIRED' }));
    if (!compatible) process.exitCode = 1;
  } else if (action === 'maintenance') {
    const acquired = await maintenance(runtime, false);
    console.log(JSON.stringify({ acquired }));
    if (!acquired) process.exitCode = 2;
  } else if (action === 'maintenance-release') {
    await maintenance(runtime, true); console.log(JSON.stringify({ released: true }));
  } else if (action === 'status') {
    const result = await releaseStatus(runtime, id); console.log(JSON.stringify(result));
    if (!result.httpReady || !result.workerReady || !result.codexReady || !result.releaseMatches || !result.assetsReady) process.exitCode = 1;
  } else throw new Error('DEPLOY_INVALID_ARGUMENTS');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const preparation = process.argv[2] === 'prepare' ? { schemaVersion: 1, operation: 'prepare', status: 'failed' } : {};
    console.error(JSON.stringify({ ...preparation, code: /^DEPLOY_[A-Z_]+$/.test(error?.message || '') ? error.message : 'DEPLOY_FAILED' }));
    process.exitCode = 1;
  });
}
