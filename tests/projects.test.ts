import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../src/server/config.js';
import { Files } from '../src/server/files.js';
import { ProjectCatalog } from '../src/server/projects.js';
import { Store } from '../src/server/store.js';

describe('shared desktop project catalog', () => {
  let temporary: string;
  let config: AppConfig;
  let store: Store;
  let primary: string;
  let worktree: string;
  let secondary: string;
  let statePath: string;
  let state: Record<string, any>;
  let official: any[];
  let bridge: { request: Mock<(method: string, params?: any) => Promise<any>> };
  beforeEach(async () => {
    temporary = await mkdtemp(path.join(os.tmpdir(), 'pocketagent-projects-test-'));
    primary = path.join(temporary, 'registered', 'Primary');
    worktree = path.join(temporary, 'external-worktrees', 'Primary worktree');
    secondary = path.join(temporary, 'registered', 'Secondary');
    const codexHome = path.join(temporary, 'synthetic-codex-home');
    for (const directory of [primary, worktree, secondary, codexHome]) await mkdir(directory, { recursive: true });
    await writeFile(path.join(primary, 'main.txt'), 'Synthetic primary content');
    await writeFile(path.join(worktree, 'worktree.txt'), 'Synthetic worktree content');
    config = { host: '127.0.0.1', port: 47831, dataDir: path.join(temporary, 'runtime'), checkoutDir: path.join(temporary, 'checkout'), projectRoots: [path.join(temporary, 'unused-parent')], codexHome };
    store = new Store(config.dataDir);
    official = [
      { id: 'official-primary', name: 'Desktop primary name', roots: [{ path: primary }, { path: worktree }], position: 0 },
      { id: 'official-secondary', name: 'Desktop secondary name', roots: [{ path: secondary }], position: 1 },
    ];
    bridge = { request: vi.fn(async (method: string, params: any) => {
      if (method === 'project/list') return { data: official, nextCursor: null };
      if (method === 'project/read') return { project: official.find(project => project.id === params.projectId) };
      throw new Error('UNEXPECTED_TEST_RPC');
    }) };
    state = {
      'local-projects': [{ id: 'legacy-primary', name: 'Old local name', rootPaths: [primary, worktree] }, { id: 'legacy-secondary', name: 'Old secondary name', rootPaths: [secondary] }],
      'project-order': ['legacy-secondary', 'legacy-primary'],
      'app-server-project-id-by-legacy-project-id-by-host': { [`local:${codexHome}`]: { 'legacy-primary': 'official-primary', 'legacy-secondary': 'official-secondary', 'legacy-unknown': 'unregistered-official-project' } },
      'thread-project-assignments': {
        'primary-history': { projectKind: 'local', projectId: 'legacy-primary' },
        'secondary-history': { projectKind: 'local', projectId: 'legacy-secondary' },
        'unregistered-history': { projectKind: 'local', projectId: 'legacy-unknown' },
        'remote-history': { projectKind: 'remote', projectId: 'legacy-primary' },
      },
    };
    statePath = path.join(codexHome, '.codex-global-state.json');
    await writeFile(statePath, JSON.stringify(state));
  });
  afterEach(async () => {
    store.close();
    await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  it('uses official project identity, desktop order and registered roots without listing unrelated folders', async () => {
    await mkdir(path.join(temporary, 'registered', 'Unregistered directory'));
    const catalog = new ProjectCatalog(config, bridge);
    const files = new Files(config, store, catalog);
    expect(await files.projects()).toEqual([
      { id: 'official-secondary', name: 'Desktop secondary name', path: secondary, roots: [secondary] },
      { id: 'official-primary', name: 'Desktop primary name', path: primary, roots: [primary, worktree] },
    ]);
    expect(await catalog.project('official-primary')).toMatchObject({ id: 'official-primary', name: 'Desktop primary name', roots: [primary, worktree] });
    expect(bridge.request).toHaveBeenCalledWith('project/list', { limit: 100, sortKey: 'position' });
    expect(bridge.request).toHaveBeenCalledWith('project/read', { projectId: 'official-primary' });
    await expect(files.project('unregistered-directory')).rejects.toMatchObject({ statusCode: 404 });
  });
  it('resolves legacy assignments only through the selected local home and leaves desktop state untouched', async () => {
    const before = await readFile(statePath, 'utf8');
    const catalog = new ProjectCatalog(config, bridge);
    expect(await catalog.threadIds('official-primary')).toEqual(['primary-history']);
    expect(await new Files(config, store, catalog).threadIds('official-secondary')).toEqual(['secondary-history']);
    expect(await readFile(statePath, 'utf8')).toBe(before);
    const local = state['app-server-project-id-by-legacy-project-id-by-host'][`local:${config.codexHome}`];
    state['app-server-project-id-by-legacy-project-id-by-host'] = { [`local:${path.join(temporary, 'different-home')}`]: local, local };
    await writeFile(statePath, JSON.stringify(state));
    expect(await catalog.threadIds('official-primary')).toEqual([]);
    state['app-server-project-id-by-legacy-project-id-by-host'] = { local };
    await writeFile(statePath, JSON.stringify(state));
    expect(await catalog.threadIds('official-primary')).toEqual(['primary-history']);
    if (process.platform === 'win32') {
      state['app-server-project-id-by-legacy-project-id-by-host'] = { [`local:${config.codexHome!.toUpperCase()}`]: local };
      await writeFile(statePath, JSON.stringify(state));
      expect(await catalog.threadIds('official-primary')).toEqual(['primary-history']);
    }
  });
  it('paginates official projects and never substitutes local metadata or folder scanning on missing state', async () => {
    await rm(statePath);
    bridge.request.mockImplementation(async (method: string, params: any) => {
      if (method === 'project/list') return params.cursor ? { data: [official[1]], nextCursor: null } : { data: [official[0]], nextCursor: 'synthetic-next-page' };
      if (method === 'project/read') return { project: official.find(project => project.id === params.projectId) };
      throw new Error('UNEXPECTED_TEST_RPC');
    });
    const catalog = new ProjectCatalog(config, bridge);
    expect((await catalog.list()).map(project => project.id)).toEqual(['official-primary', 'official-secondary']);
    expect(bridge.request).toHaveBeenCalledWith('project/list', { limit: 100, sortKey: 'position', cursor: 'synthetic-next-page' });
    expect(await catalog.threadIds('official-primary')).toEqual([]);
    bridge.request.mockImplementation(async () => ({ data: [], nextCursor: null }));
    expect(await catalog.projects()).toEqual([]);
  });
  it('browses every registered project root and refuses traversal, unrelated roots and private aliases', async () => {
    const files = new Files(config, store, new ProjectCatalog(config, bridge));
    expect((await files.tree('official-primary')).entries.map(entry => entry.path)).toEqual(['@root-0', '@root-1']);
    expect((await files.read('official-primary', '@root-0/main.txt')).content).toBe('Synthetic primary content');
    expect((await files.read('official-primary', '@root-1/worktree.txt')).content).toBe('Synthetic worktree content');
    expect((await files.tree('official-secondary')).path).toBe('');
    await expect(files.assertThread('official-primary', worktree)).resolves.toMatchObject({ id: 'official-primary' });
    await expect(files.assertThread('official-primary', secondary)).rejects.toMatchObject({ statusCode: 403 });
    await expect(files.read('official-primary', '@root-1/../../registered/Secondary/private.txt')).rejects.toMatchObject({ statusCode: 403 });
    await expect(files.read('official-primary', '@root-9/main.txt')).rejects.toMatchObject({ statusCode: 403 });
    await mkdir(path.join(worktree, '.git'));
    await writeFile(path.join(worktree, '.git', 'config'), 'Synthetic private configuration');
    await symlink(path.join(worktree, '.git'), path.join(worktree, 'private-alias'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(files.read('official-primary', '@root-1/private-alias/config')).rejects.toMatchObject({ statusCode: 403 });
  });
});
