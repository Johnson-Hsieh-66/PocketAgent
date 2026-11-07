import { randomUUID } from 'node:crypto';
import { mkdir, readdir, realpath, stat, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Attachment, FileEntry, Project } from '../shared/types.js';
import { isWithin, type AppConfig } from './config.js';
import { Store, type StoredAttachment } from './store.js';
import type { ProjectSource } from './projects.js';

export class HttpError extends Error { constructor(public statusCode: number, message: string) { super(message); } }
const privateName = (name: string) => ['.git', '.codex', '.aws', 'node_modules'].includes(name.toLowerCase()) || /^\.env(?:\.|$)/i.test(name);

export class Files {
  constructor(private config: AppConfig, private store: Store, private source: ProjectSource) {}
  projects(): Promise<Project[]> { return this.source.projects(); }
  async project(id: string): Promise<Project> {
    const project = this.source.project ? await this.source.project(id) : (await this.projects()).find(item => item.id === id);
    if (!project || project.id !== id) throw new HttpError(404, 'PROJECT_NOT_FOUND');
    return project;
  }
  async threadIds(projectId: string): Promise<string[]> { return this.source.threadIds ? this.source.threadIds(projectId) : []; }
  private roots(project: Project): string[] { return (project.roots?.length ? project.roots : [project.path]).filter(root => path.isAbsolute(root)); }
  async assertThread(projectId: string, cwd: string): Promise<Project> {
    const project = await this.project(projectId);
    let resolved: string;
    try { resolved = await realpath(cwd); } catch { throw new HttpError(403, 'THREAD_OUTSIDE_PROJECT'); }
    const roots = await Promise.all(this.roots(project).map(root => realpath(root).catch(() => null)));
    if (!roots.some(root => root !== null && isWithin(root, resolved))) throw new HttpError(403, 'THREAD_OUTSIDE_PROJECT');
    return project;
  }
  private async resolve(projectId: string, relative = ''): Promise<{ project: Project; resolved: string; relative: string }> {
    const project = await this.project(projectId);
    if (path.isAbsolute(relative) || relative.includes('\0') || relative.split(/[\\/]/).some(privateName)) throw new HttpError(403, 'PATH_NOT_ALLOWED');
    const roots = this.roots(project);
    if (!roots.length) throw new HttpError(403, 'PROJECT_HAS_NO_LOCAL_ROOTS');
    let selected = 0;
    let localRelative = relative;
    let prefix = '';
    if (roots.length > 1) {
      const [marker, ...segments] = relative.split(/[\\/]/);
      const match = /^@root-(0|[1-9]\d*)$/.exec(marker);
      if (!match || Number(match[1]) >= roots.length) throw new HttpError(403, 'PROJECT_ROOT_REQUIRED');
      selected = Number(match[1]);
      localRelative = segments.join(path.sep);
      prefix = `@root-${selected}`;
    }
    let root: string;
    try { root = await realpath(roots[selected]); } catch { throw new HttpError(404, 'PROJECT_ROOT_UNAVAILABLE'); }
    const candidate = path.resolve(root, localRelative);
    if (!isWithin(root, candidate)) throw new HttpError(403, 'PATH_OUTSIDE_PROJECT');
    let resolved: string;
    try { resolved = await realpath(candidate); } catch { throw new HttpError(404, 'FILE_NOT_FOUND'); }
    if (!isWithin(root, resolved) || isWithin(this.config.dataDir, resolved)) throw new HttpError(403, 'PATH_OUTSIDE_PROJECT');
    if (path.relative(root, resolved).split(path.sep).some(privateName)) throw new HttpError(403, 'PATH_NOT_ALLOWED');
    const localPath = path.relative(root, resolved).split(path.sep).join('/');
    return { project, resolved, relative: prefix ? localPath ? `${prefix}/${localPath}` : prefix : localPath };
  }
  async tree(projectId: string, relative = ''): Promise<{ entries: FileEntry[]; path: string }> {
    const project = await this.project(projectId);
    const roots = this.roots(project);
    if (!relative && roots.length > 1) return { path: '', entries: roots.map((root, index) => ({ name: path.basename(root) || root, path: `@root-${index}`, type: 'directory' })) };
    const target = await this.resolve(projectId, relative);
    if (!(await stat(target.resolved)).isDirectory()) throw new HttpError(400, 'NOT_A_DIRECTORY');
    const entries: FileEntry[] = [];
    for (const entry of await readdir(target.resolved, { withFileTypes: true })) {
      if (privateName(entry.name)) continue;
      try {
        const child = await this.resolve(projectId, path.join(target.relative, entry.name));
        const info = await stat(child.resolved);
        if (!info.isFile() && !info.isDirectory()) continue;
        entries.push({ name: entry.name, path: path.join(target.relative, entry.name).split(path.sep).join('/'), type: info.isDirectory() ? 'directory' : 'file', ...(info.isFile() ? { size: info.size } : {}) });
      } catch { /* Do not expose inaccessible paths or escaping links. */ }
    }
    entries.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1);
    return { entries, path: target.relative };
  }
  async read(projectId: string, relative: string): Promise<{ path: string; content: string; truncated: boolean }> {
    const target = await this.resolve(projectId, relative);
    const handle = await open(target.resolved, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new HttpError(400, 'NOT_A_FILE');
      const bytes = Buffer.alloc(Math.min(info.size, 256 * 1024));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const content = bytes.subarray(0, bytesRead);
      if (content.includes(0)) throw new HttpError(415, 'BINARY_FILE');
      return { path: target.relative, content: content.toString('utf8'), truncated: info.size > bytesRead };
    } finally { await handle.close(); }
  }
  async upload(projectId: string, name: string, claimedMime: string, data: Buffer): Promise<Attachment> {
    await this.project(projectId);
    if (data.length === 0 || data.length > 10 * 1024 * 1024) throw new HttpError(413, 'IMAGE_TOO_LARGE');
    let mime: string | undefined;
    if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mime = 'image/png';
    else if (data[0] === 255 && data[1] === 216 && data[2] === 255) mime = 'image/jpeg';
    else if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') mime = 'image/webp';
    if (!mime || claimedMime !== mime) throw new HttpError(415, 'UNSUPPORTED_IMAGE');
    const id = randomUUID();
    const uploadDir = path.join(this.config.dataDir, 'uploads');
    await mkdir(uploadDir, { recursive: true, mode: 0o700 });
    const outputPath = path.join(uploadDir, id);
    await writeFile(outputPath, data, { flag: 'wx', mode: 0o600 });
    const safeName = path.basename(name.replaceAll('\\', '/')).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180) || 'image';
    this.store.addAttachment({ id, projectId, name: safeName, mime, size: data.length, path: outputPath, createdAt: Date.now() });
    return { id, name: safeName, mime, size: data.length };
  }
  async attachment(id: string, projectId?: string): Promise<StoredAttachment> {
    const attachment = this.store.attachment(id);
    if (!attachment || (projectId && attachment.projectId !== projectId)) throw new HttpError(404, 'ATTACHMENT_NOT_FOUND');
    await this.project(attachment.projectId);
    const uploadDir = await realpath(path.join(this.config.dataDir, 'uploads'));
    const resolved = await realpath(attachment.path);
    if (!isWithin(uploadDir, resolved)) throw new HttpError(403, 'ATTACHMENT_NOT_ALLOWED');
    return { ...attachment, path: resolved };
  }
}
