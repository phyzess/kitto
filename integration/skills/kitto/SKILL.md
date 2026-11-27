---
name: kitto
description: Inspect, synchronize and update personal agent configuration across machines with Kitto. Use for Kitto setup, configuration drift, dependency versions, syncing personal skills, model routing, or when the kitto command is missing or reports an unknown subcommand.
---

Use the installed maintenance runner. Setup replaces `KITTO_RUNNER` below with its absolute, shell-quoted path. If it is still a placeholder, Kitto setup has not completed; do not guess an installation path.

```sh
node KITTO_RUNNER status
```

**Routing, missing `kitto`, or an unknown subcommand:** In a full local installation, use the CLI bound by this deployed skill, even if `PATH` has another copy:

```sh
node KITTO_CLI route --help
```

For other commands, use `--help` instead of `route --help`. Run this only if setup rendered an absolute path. Use the same entry for routing preflight; no maintenance `status` call is needed for routing. If the path is unrendered, the file is absent, or the installed CLI lacks `route`, report that specific blocker and leave any team plan staged. Do not substitute a checkout, an npm cache, or the maintenance runner.

Keep normal work in the current native agent. Do not introduce a launcher or modify project configuration. The runner exposes only these maintenance operations:

| Operation | Behavior |
|---|---|
| `status` | Read installation state and configuration differences locally |
| `versions` | Read installed and declared component versions |
| `versions --online` | Also query registry release channels; no installation |
| `sync` | Preview repository-to-machine configuration deployment |
| `sync --apply` | Deploy configuration and reconnect native integrations |
| `update` / `update --check` | Preview the source branch's remote head, the runtime copy and the deployment plan without fetching or writing |
| `update --apply` | Fast-forward a clean tracked source branch, refresh the installed runtime copy when run from an external Kitto package, then deploy |
| `hosts` / `hosts --apply` | Preview / install selected hosts' pinned tested baseline through npm; exact `--version` and one `--host` only, never automatic |
| `export` | Preview sanitized Pi machine-to-repository export |
| `export --apply` | Write that export to the local source checkout; never commit or push |
| `deps` / `deps --apply` | Preview / install CLI dependencies needed by the selected hosts and enabled capabilities, only when requested |
| `recover` / `recover --apply` | Preview / restore the last verified Kitto code checkpoint and reconnect native integrations |
| `remove` / `remove --apply` | Preview / detach Kitto's native integrations; retain personal configuration, shared skills, CLIs and recovery files |

Begin with `status`. For changes, inspect the corresponding preview, explain concrete conflicts or scope, and apply within the user's authorization. A sync may install the source's declared Pi packages. Existing shared skill directories are preserved when different; report conflicts and resolve them with the user rather than deleting them. Local edits or diverged source history stop an update; never reset or stash them automatically.

Use `versions --online` when asked about upgrades. Distinguish installed, declared and upstream versions, including prereleases and engine requirements. Registry metadata is not a compatibility test. Kitto does not bulk-upgrade hosts or plugins: for selected hosts, `kitto hosts` previews installed versions, the tested baselines and the exact native-manager commands, and only an explicit `kitto hosts --apply` installs those pinned baselines through npm; it never follows `latest` and never upgrades automatically. Use each native manager for anything beyond that baseline, test the relevant host, and update the source only after validation. Update Kitto itself by rerunning its npm setup entry with the intended package version; `update --apply` prints the installed and tested-baseline host versions but never upgrades a host CLI. `update` and `update --check` are previews; `update --apply` also refuses dirty, detached/tag, upstream-less and diverged checkouts before writing. This bundled runner cannot replace its own runtime copy, so `node KITTO_RUNNER update --apply` only fast-forwards and redeploys; refresh the runtime with the intended Kitto package instead. A replaced runtime is verified only after its deployment succeeds, so `recover` returns to the last successfully deployed version. A lost checkout is restored only from its recorded branch; tag-pinned or unknown refs must be recreated in place, or the machine reinstalled with a new KITTO_HOME. The running process completes its deployment with the code it started with; later calls use the refreshed runtime.

For a change intended for every machine, edit the source checkout. Write host-specific changes under the corresponding `config/<agent>/` and common workflows under `skills/`. Show the Git diff, preview and apply sync, and report whether the changes have reached the remote. For this machine only, use the native host's local override. For Codex and DSH instructions, keep local text outside Kitto's managed block. For Pi, use its existing local settings and MCP overrides. When migrating an existing machine, first identify shared content, local changes and machine-specific tools, then transfer only the selected portable items.

The source checkout owns shared skills, host-specific skills, Pi settings, and managed instruction blocks for Codex and DSH. Codex and DSH keep their own authentication, model choices and permissions. Codex MCP is synced from the enabled Pi source as a credential-free whitelist; DSH MCP remains native. Check the current session for any optional tools a skill needs. Read the source's documentation before changing personal assets. Report what changed, skipped conflicts, failures and any required native reload. Stop on errors; rerun only after resolving the cause.

Recovery only changes Kitto code and its native registration, preserving the currently deployed personal configuration. It is not a transaction rollback of all earlier file changes or dependency installs. If the installed runner cannot start, use the same package setup entry with `--recover --dry-run`, then `--recover` within the user's request. This external entry also works when recovering an older Kitto version whose skill lacks recovery commands. With no verified checkpoint, rerun setup from a known working package version.

Removal is resumable: repeat it after fixing a native-manager error. It never deletes the source checkout, shared skills, agent CLIs or authentication. Native registrations that point to another source are preserved and reported as conflicts. After detaching, use setup to reinstall; ordinary sync must not reconnect a removed integration implicitly. Complete the requested maintenance without running the agent's task through Kitto.
