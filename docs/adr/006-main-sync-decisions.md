# ADR 006: Distinguish stale state from slow or unverified work

Status: accepted (records behavior at upstream `5368e35ddee521a389e9c676b4edb3929937c8fc`).

## Context

A partial deployment, a live operation, and a dead operation can look alike from disk. Likewise, a version-manager shim or the npm registry can be slow without indicating a failed operation.

## Decision

- **Write locks.** Record the installation owner in `owner.json` and the Pi adapter owner in `pid` beside its configuration checkout. Distinguish missing or invalid ownership from a recorded, dead PID; `EPERM` from the Node liveness probe means the process exists, not that it exited. Require explicit `--break-lock` to remove a recorded dead owner's residue, and leave ownerless/legacy locks for manual inspection. Keep normal-exit cleanup and explicit `SIGINT`/`SIGTERM` cleanup; `SIGKILL` cannot run a handler. A cleanup failure in the signal path must not mask the signal exit status. The adapter diagnostic reports live, exited and unverifiable owners separately; identity-conditional stale-lock replacement is tracked in the [lock follow-up](../issue-drafts/main-sync-follow-ups.md).
- **Runtime checkpoint.** Keep the previous verified runtime until deployment succeeds. After a refreshed runtime has been put on disk but deployment fails, report that it is still unverified and give the operator both routes: retry apply or recover. See [ADR 003](003-runtime-and-worktree-safety.md#runtime-lifecycle).
- **Release integrity.** An npm publish acknowledgement precedes registry availability. Read `dist.integrity` up to 24 times with 15 seconds between reads (23 waits at most); retry only while integrity is unavailable. An integrity mismatch fails immediately. Keep the polling logic importable so tests can simulate availability and mismatch without an actual publish or real sleeps.

## Consequences

The [usage guide](../usage.md#被中断的运行残留锁与未验证的-runtime) describes the operator-facing diagnostics. Treat an eventually consistent read as a bounded wait, not as proof of success. The CLI fixture timeout catches hangs, not performance regressions: setup fans out to child processes, and other test files can run in parallel. Native host version and capability handling is recorded separately in [ADR 004](004-native-integration-policy.md).
