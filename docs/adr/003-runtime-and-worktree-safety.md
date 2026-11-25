# ADR 003: Checkpoint working runtimes and require positive worktree evidence

Status: accepted (records existing behavior).

## Context

Kitto switches its bundled runtime, deploys to native hosts, and can operate on local worktrees. Crashes and disagreement between local metadata and disk are normal possibilities. An ambiguous observation is not proof of ownership, inactivity, or a clean checkout.

## Decision

### Runtime lifecycle

- Copy only the runtime file allowlist (aligned with npm packaging), not personal config. Replace skill directories via staging. Restore an interrupted runtime rename and separate a new staged/active runtime from the last deployment-verified recovery checkpoint. Apply resolves configuration conflicts before switching runtimes, then uses the code loaded by the current process to finish deployment; restart native hosts to use the new copy. A retry cannot checkpoint an unverified runtime. Persist ownership before invoking native managers so a stopped run can retry. Recovery and removal remain available without the personal checkout; removal preflights remaining hosts before changing them.
- Only another Kitto package can replace the installed runtime that is currently running. Compare canonical filesystem locations (including macOS aliases), not the string used to launch it. Native launchers may not inherit the setup environment. Keep host CLI upgrades separate from Kitto code updates.
- A managed source records its bootstrap URL and ref so it can recover, and follows later origin changes. Do not infer restore coordinates for a user-owned checkout. An explicit ref wins; for a missing tagged checkout both preview and apply require the recorded ref instead of guessing. Keep clone coordinates for replay but redact credentials in output. Fast-forward only; a local-ahead branch is not divergence.

### Worktree audit and removal

- Strip inherited `GIT_*` controls from local probes; preserve meaningful path whitespace, and treat warnings or partial results as unknown. Verify a linked gitfile has a matching administrative backlink. Use bounded compatible disk accounting, never partial totals. Read-only status must not invoke clean/process filters, including in submodules; skip index-dependent probes when split-index metadata introduces writes even with optional locks disabled.
- Apply re-resolves the approved repository under a lock. Creation requires a correctly registered checkout at the approved commit and validates filters in the linked checkout, where conditional Git config may differ. Finish checks raw disk bytes, index and commit independently, without conversion or reliance on Git's cache; on Linux check same-device bind mounts explicitly. A persisted host event can suggest a local handoff, but never proves it safe to release a claim. Hints use only the current repository's private ledger and do not expose other task/session paths or identities.

## Consequences

Recovery can be retried without turning a failed update into the new recovery target. Some configurations intentionally yield unknown/blocked worktree results rather than a best guess. Verify changes against the [runtime failure tests](../../tests/kitto.test.mjs), [audit tests](../../tests/worktree-audit.test.mjs) and [lifecycle tests](../../tests/worktree-lifecycle.test.mjs).
