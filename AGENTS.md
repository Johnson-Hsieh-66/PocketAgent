# PocketAgent contributor instructions

PocketAgent is a private, self-hosted mobile web interface to the local Codex CLI. This repository is PUBLIC. Preserve the existing MIT LICENSE.

## Architecture
- Node.js 24, TypeScript, Fastify, React and Vite. The backend owns a Codex app-server stdio child; browsers receive only the curated PocketAgent API.
- Use the installed CLI's generated protocol types. Never directly edit Codex credentials, session JSONL files or databases.
- Browser disconnection must not stop a turn. Never automatically replay a prompt after a crash. Only one active turn per thread.
- Default to workspace-write and interactive approvals. Never silently weaken account or workspace policies.

## Privacy boundary
- All runtime state belongs outside the checkout under the user's LOCALAPPDATA/PocketAgent directory (or an explicitly configured external data directory).
- Never commit authentication files, cookies, device tokens, pairing codes, prompts, session transcripts, uploads, databases, logs, actual IP addresses, personal paths or company/project data.
- Tests, screenshots and documentation use synthetic fixtures and placeholder paths only. Do not inspect user credentials for debugging.
- Diagnostic logs contain only allowlisted metadata and error codes, never raw RPC messages, request bodies, command output or secrets.
- Before every commit or push, inspect the full staged diff and run the repository secret check. Do not stage directories wholesale without inspecting the resulting file list.
- No telemetry, external screenshot uploads or runtime data in CI artifacts. Keep Codex authentication on the server.

## Development
- Run npm ci, npm run protocol:generate, npm run typecheck, npm test and npm run build as appropriate.
- Keep Windows child launches hidden, avoid shell-interpolated arguments, and clean up only the process tree owned by this service.
- Validate authenticated HTTP and WebSocket requests, Host/Origin, project roots and attachment ownership on the backend.
- Escape/sanitize rendered content. Never render model-provided raw HTML.
- Keep tracked examples generic; local configuration is generated into the external runtime directory.
