import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const helperPath = path.resolve('scripts/release.mjs');
const helper = await import(pathToFileURL(helperPath).href);
describe('immutable release preparation and verification', () => {
  let temp: string;
  let checkout: string;
  let runtime: string;
  let commands: { args: string[]; cwd: string }[];
  const write = async (file: string, text: string) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); };
  const runCommand = async (_command: string, args: string[], cwd: string) => {
    commands.push({ args, cwd });
    if (args.includes('ci')) await write(path.join(cwd, 'node_modules/synthetic-package/index.js'), 'export const synthetic = true;');
  };
  beforeEach(async () => {
    temp = await mkdtemp(path.join(os.tmpdir(), 'pocketagent-release-test-'));
    checkout = path.join(temp, 'synthetic-checkout'); runtime = path.join(temp, 'external-runtime');
    await mkdir(runtime, { recursive: true });
    commands = [];
    await write(path.join(checkout, 'package.json'), JSON.stringify({ name: 'pocketagent', private: true }));
    await write(path.join(checkout, 'package-lock.json'), '{}');
    await write(path.join(checkout, 'LICENSE'), 'Synthetic license fixture');
    await write(path.join(checkout, 'scripts/release.mjs'), '// Synthetic release fixture');
    await write(path.join(checkout, 'dist/server/src/server/worker.js'), "import './codex.js';\n");
    await write(path.join(checkout, 'dist/server/src/server/codex.js'), 'export const syntheticVersion = 1;');
    await write(path.join(checkout, 'dist/client/index.html'), '<script type="module" src="/assets/synthetic.js"></script>');
    await write(path.join(checkout, 'dist/client/assets/synthetic.js'), 'console.log("Synthetic");');
  });
  afterEach(async () => { await rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  it('finishes all checks before staging and leaves active pointers untouched', async () => {
    const id = await helper.prepareRelease(runtime, { checkout, runCommand });
    expect(commands.slice(0, 5).map(item => item.args.at(-1))).toEqual(['protocol:generate', 'typecheck', 'test', 'build', 'secret:check']);
    expect(commands.at(-1)?.args).toContain('--omit=dev');
    expect(commands.at(-1)?.cwd).toBe(path.join(runtime, 'releases', id));
    const verified = await helper.verifyRelease(runtime, id);
    expect(verified.manifest.files.some((entry: { path: string }) => entry.path === 'dist/client/assets/synthetic.js')).toBe(true);
    await expect(readFile(path.join(runtime, 'active-release.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(runtime, 'pinned-release.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('a failed build cannot switch or remove the currently deployed release', async () => {
    const active = JSON.stringify({ schemaVersion: 1, releaseId: 'synthetic-current' });
    await write(path.join(runtime, 'active-release.json'), active);
    await expect(helper.prepareRelease(runtime, { checkout, runCommand: async (_command: string, args: string[], cwd: string) => {
      if (args.at(-1) === 'build') throw new Error('Synthetic build failure');
      await runCommand(_command, args, cwd);
    } })).rejects.toThrow('DEPLOY_PREPARE_BUILD_FAILED');
    expect(await readFile(path.join(runtime, 'active-release.json'), 'utf8')).toBe(active);
    await expect(readFile(path.join(runtime, 'releases'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each([
    ['protocol:generate', 'DEPLOY_PREPARE_PROTOCOL_FAILED'],
    ['typecheck', 'DEPLOY_PREPARE_TYPECHECK_FAILED'],
    ['test', 'DEPLOY_PREPARE_TESTS_FAILED'],
    ['build', 'DEPLOY_PREPARE_BUILD_FAILED'],
    ['secret:check', 'DEPLOY_PREPARE_SECRET_CHECK_FAILED'],
    ['ci', 'DEPLOY_PREPARE_INSTALL_FAILED'],
  ])('attributes a failed preparation gate without retaining native error text: %s', async (task, code) => {
    const active = JSON.stringify({ schemaVersion: 1, releaseId: 'synthetic-current' });
    await write(path.join(runtime, 'active-release.json'), active);
    await write(path.join(runtime, 'pinned-release.json'), active);
    await expect(helper.prepareRelease(runtime, { checkout, runCommand: async (command: string, args: string[], cwd: string) => {
      if (args.includes(task)) throw new Error('SYNTHETIC_SECRET C:\\Synthetic Private\\prompt.txt');
      await runCommand(command, args, cwd);
    } })).rejects.toThrow(code);
    expect(await readFile(path.join(runtime, 'active-release.json'), 'utf8')).toBe(active);
    expect(await readFile(path.join(runtime, 'pinned-release.json'), 'utf8')).toBe(active);
  });
  it('rejects tampering and files added after the release was sealed', async () => {
    const id = await helper.prepareRelease(runtime, { checkout, runCommand });
    const asset = path.join(runtime, 'releases', id, 'dist/client/assets/synthetic.js');
    await writeFile(asset, 'Synthetic tampered bundle');
    await expect(helper.verifyRelease(runtime, id)).rejects.toThrow('DEPLOY_INTEGRITY_FAILED');
    await writeFile(asset, 'console.log("Synthetic");');
    await write(path.join(runtime, 'releases', id, 'extra.txt'), 'Synthetic unexpected file');
    await expect(helper.verifyRelease(runtime, id)).rejects.toThrow('DEPLOY_INTEGRITY_FAILED');
  });
  it('hashes every file in a multi-directory release and rechecks same-size changes and removals', async () => {
    const contents = new Map<string, string>();
    for (let index = 0; index < 64; index++) {
      const relative = `dist/client/assets/synthetic-${index % 8}/file-${String(index).padStart(3, '0')}.js`;
      const value = `export const row = ${index};\n` + 'synthetic payload\n'.repeat(index % 9);
      contents.set(relative, value);
      await write(path.join(checkout, relative), value);
    }
    const id = await helper.prepareRelease(runtime, { checkout, runCommand });
    const release = path.join(runtime, 'releases', id);
    const verified = await helper.verifyRelease(runtime, id);
    const baseline = ['package.json', 'package-lock.json', 'LICENSE', 'scripts/release.mjs',
      'dist/server/src/server/worker.js', 'dist/server/src/server/codex.js',
      'dist/client/index.html', 'dist/client/assets/synthetic.js', 'node_modules/synthetic-package/index.js'];
    expect(verified.manifest.files.map((file: { path: string }) => file.path)).toEqual([...baseline, ...contents.keys()].sort((a, b) => a.localeCompare(b)));
    for (const [relative, value] of contents) {
      expect(verified.manifest.files.find((file: { path: string }) => file.path === relative)).toEqual({
        path: relative, bytes: Buffer.byteLength(value), sha256: createHash('sha256').update(value).digest('hex'),
      });
    }
    const [relative, original] = [...contents][61];
    await writeFile(path.join(release, relative), original.replace('row', 'bad'));
    await expect(helper.verifyRelease(runtime, id)).rejects.toThrow('DEPLOY_INTEGRITY_FAILED');
    await writeFile(path.join(release, relative), original);
    await expect(helper.verifyRelease(runtime, id)).resolves.toHaveProperty('manifest.releaseId', id);
    await rm(path.join(release, [...contents.keys()][63]));
    await expect(helper.verifyRelease(runtime, id)).rejects.toThrow('DEPLOY_INTEGRITY_FAILED');
  });
  it('retains the internal npm shim exception during full verification', async () => {
    const id = await helper.prepareRelease(runtime, { checkout, runCommand });
    const release = path.join(runtime, 'releases', id);
    await mkdir(path.join(release, 'node_modules/.bin'));
    await symlink(path.join(release, 'node_modules/synthetic-package'), path.join(release, 'node_modules/.bin/synthetic-shim'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(helper.verifyRelease(runtime, id)).resolves.toHaveProperty('manifest.releaseId', id);
  });
  it.each(['internal-unsupported', 'escaped-npm-shim'])('retains inventory link checks: %s', async kind => {
    const id = await helper.prepareRelease(runtime, { checkout, runCommand });
    const release = path.join(runtime, 'releases', id);
    if (kind === 'escaped-npm-shim') {
      const outside = path.join(temp, 'synthetic-outside'); await mkdir(outside);
      await mkdir(path.join(release, 'node_modules/.bin'));
      await symlink(outside, path.join(release, 'node_modules/.bin/synthetic-escape'), process.platform === 'win32' ? 'junction' : 'dir');
    } else {
      await symlink(path.join(release, 'dist'), path.join(release, 'synthetic-internal-link'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    await expect(helper.verifyRelease(runtime, id)).rejects.toThrow(kind === 'escaped-npm-shim' ? 'DEPLOY_RELEASE_LINK_ESCAPE' : 'DEPLOY_RELEASE_LINK_UNSUPPORTED');
  });
  it('distinguishes a web-only release from a worker dependency change', async () => {
    const first = await helper.prepareRelease(runtime, { checkout, runCommand });
    await write(path.join(runtime, 'pinned-release.json'), JSON.stringify({ schemaVersion: 1, releaseId: first }));
    await write(path.join(checkout, 'dist/client/assets/synthetic.js'), 'console.log("Synthetic web update");');
    const second = await helper.prepareRelease(runtime, { checkout, runCommand });
    expect(await helper.workerCompatible(runtime, second)).toBe(true);
    await write(path.join(checkout, 'dist/server/src/server/codex.js'), 'export const syntheticVersion = 2;');
    const third = await helper.prepareRelease(runtime, { checkout, runCommand });
    expect(await helper.workerCompatible(runtime, third)).toBe(false);
  });
  it('rejects escaped release identities and junctions', async () => {
    await mkdir(path.join(runtime, 'releases'));
    await expect(helper.releaseDirectory(runtime, '../escape')).rejects.toThrow('DEPLOY_INVALID_RELEASE');
    const outside = path.join(temp, 'outside'); await mkdir(outside);
    await symlink(outside, path.join(runtime, 'releases/synthetic-escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(helper.releaseDirectory(runtime, 'synthetic-escape')).rejects.toThrow('DEPLOY_RELEASE_OUTSIDE_RUNTIME');
  });
  it('refuses to build over a live legacy checkout before migration', async () => {
    await write(path.join(runtime, 'service.json'), JSON.stringify({ pid: process.pid, entrypoint: path.join(checkout, 'dist/server/src/server/index.js') }));
    await expect(helper.prepareRelease(runtime, { checkout, runCommand })).rejects.toThrow('DEPLOY_LEGACY_SERVICE_RUNNING');
    expect(commands).toEqual([]);
  });
});
