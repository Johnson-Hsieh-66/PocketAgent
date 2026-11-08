---
name: pocketagent-update
description: Build, verify and deploy PocketAgent service changes through an independent updater, preserving Codex work during web proxy updates and rolling back unhealthy releases. Use for PocketAgent updates or recovery after an update; not for upgrading Codex, changing account permissions or network access.
---

# PocketAgent update

Use the bundled [update script](scripts/update-service.ps1) from the PocketAgent checkout. It stages a versioned release outside the checkout, runs checks, and hands activation to a separate Windows scheduled task. The web proxy and execution worker have separate lifecycles.

## Deploy

1. Confirm the checkout's package name is `pocketagent`. Preserve uncommitted work. Complete the requested fix and relevant regression tests before deployment; do not reset the checkout or update Codex itself.
2. Run `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <skill>/scripts/update-service.ps1 -Checkout <checkout>` using the current deployment authorization. The script runs protocol generation, typecheck, tests, build and secret checks; installs production dependencies in a new external release; verifies its integrity; then queues independent activation. It never builds into the running release.
   Deployment needs external runtime writes, native worker named-pipe access and Windows Task Scheduler access. If the current Codex execution sandbox restricts these capabilities, run the complete authorized wrapper through the execution tool's normal permission escalation (`exec_command` uses `sandbox_permissions="require_escalated"`), explaining these access needs. Do not change permission policies or bypass deployment checks.
   `DEPLOY_PREPARE_FAILED` occurs before this wrapper invokes Queue. Read the structured `stage` and fixed `code`, then run the failing check in the same execution context to diagnose it before another complete-wrapper attempt. Never manually queue a partial or stale release to work around it.
3. Read the structured outcome. `healthy` means the candidate's HTML/assets, authenticated worker connection and Codex readiness passed. `rolledBack` means the old release was restored; report the failed deployment accurately. Other failures leave a fixed code and receipt in external runtime state.
   Preparation has a 15-minute deadline; activation/status helpers have separate short deadlines. `pending` is not success. Preserve its receipt and query status instead of queuing another update. `DEPLOY_QUEUE_OUTCOME_UNKNOWN` means handoff may already exist: inspect the external deployment receipts before any new attempt, and never blindly replay Queue.
4. When execution-worker code changed, activation waits for **both** active turns and pending requests to reach zero. If the script reports `waitingForIdle`, return the receipt and end the current update turn so the independent updater can proceed. State that activation is pending; never claim deployment succeeded. Query later with `scripts/update.ps1 -Action Status -OperationId <receipt>`. Do not interrupt work to accelerate it unless the user explicitly requested interruption.

## Operational boundaries

- Never run `service:stop; service:start` from a PocketAgent Codex turn. The updater must acknowledge an independent scheduler process before stopping anything. `Start-Process`, `detached` and hidden windows alone do not prove isolation from a process-tree termination.
- Ordinary web updates must leave the worker's generation, active work, approvals and submission deduplication intact. A gateway disconnect does not mean a turn was interrupted. Never retry a mutating RPC or replay a prompt after a timeout.
- Keep runtime keys, state, receipts and release pointers outside the public checkout. Use the existing private listeners, device pairing and native Codex authorization. Do not modify credentials, session files, policies, firewall rules or bind addresses as part of an update.
- A sandbox access denial or failed sandbox health probe does not establish that the worker has stopped. Verify read-only readiness in the required authorized execution context; do not infer idle state or bypass the atomic maintenance claim from an inaccessible named pipe.
- A live legacy checkout needs a one-time migration when idle; fail before touching its build output. Do not bypass release-integrity, ownership, ancestry, worker-compatibility or health checks. On failure, inspect fixed diagnostic/status codes and correct the cause before one new attempt.
