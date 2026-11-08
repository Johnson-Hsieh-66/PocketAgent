# PocketAgent contributor instructions

PocketAgent is a private, self-hosted mobile web interface to the local Codex CLI. This repository is PUBLIC. Preserve the existing MIT LICENSE.

## Architecture
- Node.js 24, TypeScript, Fastify, React and Vite. A durable execution worker owns the Codex app-server stdio child; a separate, replaceable HTTP gateway uses authenticated local IPC. Browsers receive only the curated PocketAgent API. Gateway shutdown must never stop the worker or a turn.
- Use the installed CLI's generated protocol types. Never directly edit Codex credentials, session JSONL files or databases.
- Browser disconnection must not stop a turn. Never automatically replay a prompt after a crash. Only one active turn per thread.
- Inherit Codex project/session authorization through native configuration resolution. Synchronize an explicitly selected local Codex App review mode from its read-only desktop preferences through the native reviewer field when starting/resuming a thread or starting a turn; never substitute a hardcoded mode when the selection is absent, custom or unknown. Keep approval policy, sandbox, named permission profiles and mandatory account/workspace policies under native resolution; do not edit user configuration to change permissions. Read the selection again for subsequent operations so App changes take effect without a service restart.
- Private network mode binds separate loopback, physical RFC1918 LAN and Tailscale listeners sharing one Codex bridge and store. Keep Host/Origin validation specific to each listener; never broaden this into wildcard or public-address binding.
- Device pairing defaults ON for new installations. An explicit user choice may turn pairing OFF; persist that choice only in external runtime state, retain device records, and keep private binding and Host/Origin checks enforced in both modes.
- A new paginated thread can omit its project in thread/read before its first turn persists. Only the current bridge's verified thread/start assignment may fill that temporary gap; explicit conflicting projects, unrelated unassigned threads and escaped roots must still be rejected. Clear transient assignments when canonical metadata is available or the bridge disconnects.
- Populate reasoning choices from model/list and send explicit selections through turn/start effort. Resuming a conversation must preserve its existing effort unless the user changes it.

## Privacy boundary
- All runtime state belongs outside the checkout under the user's LOCALAPPDATA/PocketAgent directory (or an explicitly configured external data directory).
- Never commit authentication files, cookies, device tokens, pairing codes, prompts, session transcripts, uploads, databases, logs, actual IP addresses, personal paths or company/project data.
- Tests, screenshots and documentation use synthetic fixtures and placeholder paths only. Do not inspect user credentials for debugging.
- Diagnostic logs contain only allowlisted metadata and error codes, never raw RPC messages, request bodies, command output or secrets.
- Write diagnostics directly to the external runtime directory's logs/diagnostics.jsonl; retain at most three 1 MiB files. Allowlist code, component and operation values as well as field names; unknown codes/operations collapse to fixed generic values. Use static route templates and numeric RPC codes, never raw errors, request URLs, identifiers or filesystem paths. Logging failures must not break agent work.
- Before every commit or push, inspect the full staged diff and run the repository secret check. Do not stage directories wholesale without inspecting the resulting file list.
- No telemetry, external screenshot uploads or runtime data in CI artifacts. Keep Codex authentication on the server.
- Network discovery and listener configuration are local runtime data. Never commit real adapter names, addresses, subnets, gateways, MAC addresses or other machine/network metadata; documentation uses LAN/Tailscale placeholders.

## Development
- Run npm ci, npm run protocol:generate, npm run typecheck, npm test and npm run build as appropriate.
- Keep Windows child launches hidden, avoid shell-interpolated arguments, and clean up only the process tree owned by this service.
- Enforce device authentication for HTTP and WebSocket requests when pairing is ON; always validate Host/Origin, project roots and attachment ownership on the backend.
- Escape/sanitize rendered content. Never render model-provided raw HTML.
- Keep tracked examples generic; local configuration is generated into the external runtime directory.
- Deploy with the `pocketagent-update` skill or `npm run service:update`. Build and install dependencies in an external versioned release before activation; never replace live dependencies/assets or run stop/start from inside the execution process tree. Independent scheduler handoff, ownership checks, health verification and rollback are required. Worker upgrades require an atomic idle maintenance claim; a snapshot showing idle is insufficient.
- Test deployment publication on the actual supported PowerShell host with real existing-file overwrites and full-script bootstrap. First-write success or mocked orchestration does not prove atomic result/pointer replacement. Retain ambiguous deployment receipts, bound native helper processes and report bootstrap failures instead of leaving a permanent queued state.
- Validate self-updates from an active PocketAgent conversation: require output before and after gateway activation in the same completed turn, an unchanged execution-worker generation, and a successful subsequent turn in the same session without manual navigation. A local restart or healthy endpoint alone does not establish conversation continuity. Sandbox-denied IPC is an execution-context failure, not evidence that the worker needs restarting; use the tool's normal authorized escalation path without changing native policies.
- Deployment checks run alongside a live service and may inherit a lower process priority. Bound test-worker concurrency rather than weakening assertions or skipping checks. Windows subprocess environment overrides must replace keys case-insensitively so inherited variables cannot silently replace synthetic fixtures.

## Reliability principles

### A working API does not prove a working interface
- The browser needs a consistent HTML entry point and executable assets. Resolve static assets at request time so a build with new Vite hashes works while the service stays running. Never freeze the asset inventory at server startup.
- Missing JavaScript or CSS must return 404, never the SPA HTML fallback. Serve the HTML entry point without caching and include a visible loading/reload fallback before React mounts; a failed bundle must not leave an unexplained black screen.
- Verify delivery by requesting the entry point and every referenced asset, checking status, content type and content. Cover replacement of build assets after the HTTP server has started with a regression test.
- Local HTTP success proves only local reachability. Distinguish listener availability, browser rendering, VPN routing, firewall access and device authentication; do not report remote recovery until the relevant access path has been verified.

### History is paginated; the current view is durable
- Fetch a small page of recent turns initially. Load older history when the reader reaches the top, prevent overlapping page requests and preserve the reader's viewport when prepending.
- Bound both native thread listing and legacy metadata lookups. Prefer the app-server's state-only listing rather than repeated rollout scan-and-repair. Continuation cursors must survive removal of transient assignments without skipping threads.
- Preserve the selected project and thread across refresh using navigation identifiers only. Restore a selected thread even when it is outside the first thread-list page; the backend must still verify its project and root.
- Background refresh must preserve already loaded older pages, their ordering, the continuation cursor and the selected thread. Stale responses from a previous view must not overwrite the current view.

### Streaming is an eventually reconciled view
- WebSocket delivery can stop without a close event after mobile sleep or a network change. Use heartbeat timeouts, foreground/online reconnection and bounded read-only reconciliation of the active conversation to recover missed output and completion.
- Reconciliation must never resubmit a prompt. Merge overlapping history and events without duplicating text, truncating received output or reverting terminal states. A missed completion must not leave the composer permanently busy.
- Keep automatic scrolling tied to whether the reader is following the bottom. Streaming updates must not use smooth scrolling that makes programmatic movement look like the reader scrolling away. Avoid rerendering unchanged historical Markdown on every delta.

### Execution ownership outlives individual requests
- A timed-out start request is ambiguous: it may already have started a turn. Preserve submission deduplication, reconcile canonical state and allow interruption of the actual running turn before accepting another prompt.
- Scope start responses to their own execution claim. A late response from an earlier turn must never overwrite or release a newer turn's lock. Invalidate claims and clean up the affected thread's active state and pending requests when its lifecycle ends; leave other threads intact.
- Verify an owned process and HTTP readiness before reporting startup success. A live PID alone is insufficient. Before applying a service restart, account for active turns and pending interactions; do not silently discard work to repair the interface.
- Recovery must remain callable when Codex RPC is unresponsive. Serialize it in the worker, restart only its owned Codex process tree, close stale event clients and retain submission deduplication. Explicitly confirmed recovery may interrupt service work; a gateway update must not. Never delete history, revoke devices or replay prompts as recovery.
- Put service-wide access changes and destructive recovery behind settings and an explicit consequence confirmation. A normal browser reconnect must preserve work and drafts.
- Reliability changes need regression tests for the failure mechanism: live asset replacement, refresh restoration, overlapping history/events, missed completion, mobile reconnection and late RPC responses. Typechecking and a successful build alone cannot establish these behaviors.
