# Make stale-lock replacement conditional on owner identity

Status: local draft; not filed.

## Context and goal

The Pi adapter now distinguishes a live, provably exited and unverifiable lock owner, and never suggests removal when permission or probing fails. What remains is replacement: reading the owner and recursively deleting a directory by path are separate steps, so if that path has acquired a new owner in between, the earlier liveness result does not apply to the new lock. The reclaim paths are `acquireLock` and `breakStaleSyncLock` in [`lib/kitto.ts`](../../lib/kitto.mjs); the Pi adapter in [`lib/pi-adapter.ts`](../../lib/pi-adapter.mjs) itself has no reclaim path.

## Scope and acceptance

- Keep the existing explicit `--break-lock` interface.
- Make reclamation conditional on the observed lock identity. Cover two concurrent reclaim attempts so one caller cannot delete the replacement acquired by another. Ownership-free legacy locks must remain manual.
- Cover a deterministic owner replacement between inspection and reclamation with isolated lock fixtures. Keep the current stale-owner, live-owner, and signal-cleanup outcomes. Do not test against real users' locks.
