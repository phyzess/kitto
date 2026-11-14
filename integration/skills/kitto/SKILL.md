---
name: kitto
description: Inspect, synchronize and update personal agent configuration across machines with Kitto. Use for Kitto setup, configuration drift, dependency versions or syncing personal skills; not for ordinary project tasks.
---

Use the installed maintenance runner. Setup replaces `KITTO_RUNNER` below with its absolute, shell-quoted path. If it is still a placeholder, Kitto setup has not completed; do not guess an installation path.

```sh
node KITTO_RUNNER status
```

Keep normal work in the current native agent. Do not introduce a launcher or modify project configuration. The runner exposes only these maintenance operations:

| Operation | Behavior |
|---|---|
| `status` | Read installation state and configuration differences locally |
| `versions` | Read installed and declared component versions |
| `versions --online` | Also query registry release channels; no installation |
| `sync` | Preview repository-to-machine configuration deployment |
| `sync --apply` | Deploy configuration and reconnect native integrations |
| `update` | Preview the source branch's remote head without fetching |
| `update --apply` | Fast-forward a clean tracked source branch, then deploy |
| `export` | Preview sanitized Pi machine-to-repository export |
| `export --apply` | Write that export to the local source checkout; never commit or push |
| `deps` / `deps --apply` | Preview / install the source's declared CLI dependencies, only when requested |

Begin with `status`. For changes, inspect the corresponding preview, explain concrete conflicts or scope, and apply within the user's authorization. A sync may install the source's declared Pi packages. Existing shared skill directories are preserved when different; report conflicts and resolve them with the user rather than deleting them. Local edits or diverged source history stop an update; never reset or stash them automatically.

Use `versions --online` when asked about upgrades. Distinguish installed, declared and upstream versions, including prereleases and engine requirements. Registry metadata is not a compatibility test. Kitto does not bulk-upgrade hosts or plugins: use each native manager for explicitly selected upgrades, test the relevant host, and update the source only after validation. Update Kitto itself by rerunning its npm setup entry with the intended package version.

The source checkout owns personal skills and Pi settings. Codex and DSH keep their own authentication, model choices, permissions and MCP configuration. Do not copy Pi-only fields or rules into them. Read the source's documentation before changing personal assets. Report what changed, skipped conflicts, failures and any required native reload. Stop on errors; rerun only after resolving the cause.
