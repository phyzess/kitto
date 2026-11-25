# Make stale-lock diagnostics and replacement agree on owner identity

Status: local draft; not filed.

## Context and goal

[`sync.sh`](../../sync.sh) uses a failed `kill -0` as evidence that the recorded process exited. A live process under another UID can return a permission error instead. The Node path in [`lib/kitto.mjs`](../../lib/kitto.mjs) treats `EPERM` as live, so a direct shell diagnostic can recommend breaking a lock that the Kitto CLI correctly refuses to break. Also, reading the owner and recursively deleting a directory by path are separate steps. If that path has acquired a new owner in the meantime, the earlier liveness result does not apply to the new lock.

## Scope and acceptance

- Keep the existing explicit `--break-lock` interface. Make live, provably dead, and unknown owners distinct in both diagnostics; a permission denial must never suggest manual removal of an active lock.
- Make reclamation conditional on the observed lock identity. Cover two concurrent reclaim attempts so one caller cannot delete the replacement acquired by another. Ownership-free legacy locks must remain manual.
- Use isolated lock fixtures and an injected liveness result or two test UIDs to verify `EPERM`, then cover a deterministic owner replacement between inspection and reclamation. Keep the current stale-owner, live-owner, and signal-cleanup outcomes. Do not test against real users' locks.
