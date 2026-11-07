import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Project as OfficialProject } from '../../.generated/codex/v2/Project.js';
import type { ProjectListResponse } from '../../.generated/codex/v2/ProjectListResponse.js';
import type { ProjectReadResponse } from '../../.generated/codex/v2/ProjectReadResponse.js';
import type { Project } from '../shared/types.js';
import type { AppConfig } from './config.js';
import { HttpError } from './files.js';

export interface ProjectSource {
  projects(): Promise<Project[]>;
  project?(id: string): Promise<Project>;
  threadIds?(projectId: string): Promise<string[]>;
}
interface ProjectBridge { request(method: string, params?: any): Promise<any> }
type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const normalizeHome = (home: string) => {
  const resolved = path.resolve(home);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/** The app-server owns project identity. Desktop metadata is read only for legacy assignments. */
export class ProjectCatalog implements ProjectSource {
  private home: string;
  constructor(config: AppConfig, private bridge: ProjectBridge) {
    this.home = path.resolve(config.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  }
  private convert(project: OfficialProject): Project {
    const roots = [...new Set(project.roots.map(root => root.path).filter(root => typeof root === 'string' && path.isAbsolute(root)))];
    return { id: project.id, name: project.name, path: roots[0] || '', roots };
  }
  private async metadata(): Promise<{ state: JsonObject; mapping: JsonObject }> {
    let state: JsonObject;
    try { state = object(JSON.parse(await readFile(path.join(this.home, '.codex-global-state.json'), 'utf8'))); }
    catch { return { state: {}, mapping: {} }; }
    const byHost = object(state['app-server-project-id-by-legacy-project-id-by-host']);
    const qualified = Object.keys(byHost).filter(key => key.startsWith('local:'));
    const matching = qualified.find(key => normalizeHome(key.slice('local:'.length)) === normalizeHome(this.home));
    const mapping = matching ? object(byHost[matching]) : qualified.length === 0 ? object(byHost.local) : {};
    return { state, mapping };
  }
  async projects(): Promise<Project[]> {
    const projects: Project[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const page = await this.bridge.request('project/list', { limit: 100, sortKey: 'position', ...(cursor ? { cursor } : {}) }) as ProjectListResponse;
      for (const project of page.data) if (!seen.has(project.id)) { seen.add(project.id); projects.push(this.convert(project)); }
      cursor = page.nextCursor || undefined;
      if (cursor && cursors.has(cursor)) throw new Error('PROJECT_PAGINATION_INVALID');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    const { state, mapping } = await this.metadata();
    const legacyOrder = Array.isArray(state['project-order']) ? state['project-order'] as unknown[] : [];
    const positions = new Map<string, number>();
    for (const legacyId of legacyOrder) {
      const canonical = typeof legacyId === 'string' ? mapping[legacyId] : undefined;
      if (typeof canonical === 'string' && seen.has(canonical) && !positions.has(canonical)) positions.set(canonical, positions.size);
    }
    return projects.map((project, index) => ({ project, index })).sort((a, b) => (positions.get(a.project.id) ?? positions.size + a.index) - (positions.get(b.project.id) ?? positions.size + b.index)).map(entry => entry.project);
  }
  list(): Promise<Project[]> { return this.projects(); }
  async project(id: string): Promise<Project> {
    const response = await this.bridge.request('project/read', { projectId: id }) as ProjectReadResponse;
    if (!response?.project || response.project.id !== id) throw new HttpError(404, 'PROJECT_NOT_FOUND');
    return this.convert(response.project);
  }
  async threadIds(projectId: string): Promise<string[]> {
    await this.project(projectId);
    const { state, mapping } = await this.metadata();
    const assignments = object(state['thread-project-assignments']);
    const ids: string[] = [];
    for (const [threadId, raw] of Object.entries(assignments)) {
      const assignment = object(raw);
      if (assignment.projectKind === 'local' && typeof assignment.projectId === 'string' && mapping[assignment.projectId] === projectId) ids.push(threadId);
    }
    return ids;
  }
}
