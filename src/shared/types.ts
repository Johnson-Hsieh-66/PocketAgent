export interface Project { id: string; name: string; path: string; roots?: string[] }
export interface FileEntry { name: string; path: string; type: 'file' | 'directory'; size?: number }
export interface Thread { id: string; name?: string | null; preview: string; cwd: string; updatedAt: number; status?: { type: string }; turns?: Turn[] }
export interface Turn { id: string; status: string; items: ThreadItem[]; error?: { message?: string } | null }
export interface ThreadItem { id: string; type: string; [key: string]: unknown }
export interface Model { id: string; model: string; displayName: string; description?: string; isDefault?: boolean }
export interface PendingRequest { id: string | number; method: string; params: Record<string, unknown> }
export interface AppEvent { seq: number; method: string; params: Record<string, unknown> }
export interface Attachment { id: string; name: string; mime: string; size: number }
export interface ServiceStatus { codex: 'starting' | 'ready' | 'offline'; authenticated?: boolean; version?: string; error?: string }
