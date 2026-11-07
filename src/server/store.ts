import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomInt, randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export interface Device { id: string; name: string; createdAt: number; expiresAt: number }
export interface StoredAttachment { id: string; projectId: string; name: string; mime: string; size: number; path: string; createdAt: number }
export interface StoredSubmission { threadId: string; fingerprint: string }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

export class Store {
  private db: DatabaseSync;
  constructor(public readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(dataDir, 'state.sqlite'));
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pairing (singleton INTEGER PRIMARY KEY CHECK(singleton=1), code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, path TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS submissions (request_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  close(): void { this.db.close(); }
  pairingRequired(): boolean {
    const setting = this.db.prepare("SELECT value FROM settings WHERE key='pairing_required'").get() as { value: string } | undefined;
    return setting?.value !== '0';
  }
  setPairingRequired(required: boolean): void {
    if (typeof required !== 'boolean') throw new Error('INVALID_PAIRING_SETTING');
    this.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('pairing_required',?)").run(required ? '1' : '0');
  }
  issuePairCode(): { code: string; expiresAt: number } {
    const code = randomInt(0, 100_000_000).toString().padStart(8, '0');
    const expiresAt = Date.now() + 10 * 60 * 1000;
    this.db.prepare('INSERT OR REPLACE INTO pairing(singleton,code_hash,expires_at,attempts) VALUES(1,?,?,0)').run(hash(code), expiresAt);
    return { code, expiresAt };
  }
  pair(code: string, name: string): { token: string; device: Device } | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT code_hash,expires_at,attempts FROM pairing WHERE singleton=1').get() as {code_hash: string; expires_at: number; attempts: number} | undefined;
      if (!row || row.expires_at < Date.now() || row.attempts >= 10 || hash(code) !== row.code_hash) {
        this.db.prepare('UPDATE pairing SET attempts=attempts+1 WHERE singleton=1').run();
        this.db.exec('COMMIT');
        return null;
      }
      const token = randomBytes(32).toString('base64url');
      const device: Device = { id: randomUUID(), name, createdAt: Date.now(), expiresAt: Date.now() + SESSION_MS };
      this.db.prepare('INSERT INTO devices(id,name,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)').run(device.id, name, hash(token), device.createdAt, device.expiresAt);
      this.db.prepare('DELETE FROM pairing WHERE singleton=1').run();
      this.db.exec('COMMIT');
      return { token, device };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  authenticate(token: string | undefined): Device | null {
    if (!token || token.length > 200) return null;
    const row = this.db.prepare('SELECT id,name,created_at,expires_at FROM devices WHERE token_hash=? AND expires_at>?').get(hash(token), Date.now()) as {id: string; name: string; created_at: number; expires_at: number} | undefined;
    return row ? { id: row.id, name: row.name, createdAt: row.created_at, expiresAt: row.expires_at } : null;
  }
  devices(): Device[] {
    return (this.db.prepare('SELECT id,name,created_at,expires_at FROM devices WHERE expires_at>? ORDER BY created_at DESC').all(Date.now()) as {id: string; name: string; created_at: number; expires_at: number}[]).map(row => ({ id: row.id, name: row.name, createdAt: row.created_at, expiresAt: row.expires_at }));
  }
  revoke(id: string): void { if (id === 'all') this.db.prepare('DELETE FROM devices').run(); else this.db.prepare('DELETE FROM devices WHERE id=?').run(id); }
  readSubmission(id: string): StoredSubmission | null {
    const row = this.db.prepare('SELECT thread_id,fingerprint FROM submissions WHERE request_id=?').get(id) as {thread_id: string; fingerprint: string} | undefined;
    return row ? { threadId: row.thread_id, fingerprint: row.fingerprint } : null;
  }
  recordSubmission(id: string, threadId: string, fingerprint: string): void {
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('INVALID_SUBMISSION_FINGERPRINT');
    this.db.prepare('INSERT INTO submissions(request_id,thread_id,fingerprint,created_at) VALUES(?,?,?,?)').run(id, threadId, fingerprint, Date.now());
  }
  forgetSubmission(id: string): void { this.db.prepare('DELETE FROM submissions WHERE request_id=?').run(id); }
  addAttachment(attachment: StoredAttachment): void {
    this.db.prepare('INSERT INTO attachments(id,project_id,name,mime,size,path,created_at) VALUES(?,?,?,?,?,?,?)').run(attachment.id, attachment.projectId, attachment.name, attachment.mime, attachment.size, attachment.path, attachment.createdAt);
  }
  attachment(id: string): StoredAttachment | null {
    const row = this.db.prepare('SELECT id,project_id,name,mime,size,path,created_at FROM attachments WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return row ? { id: row.id as string, projectId: row.project_id as string, name: row.name as string, mime: row.mime as string, size: row.size as number, path: row.path as string, createdAt: row.created_at as number } : null;
  }
}
