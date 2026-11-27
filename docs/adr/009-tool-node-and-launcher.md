# ADR 009: Tool Node is separate from project Node

Status: accepted.

## Context

Agents run Kitto's own tooling (the maintenance runner, the routing CLI, the `context-budget` and `jev-decide` scripts) with a bare `node` from the current project directory. Version managers such as mise and nvm pin Node per directory, so that `node` is the project's version or the global one, depending on how each host's shell resolves `PATH` (shims or activation against a static `PATH`). The interpreter for Kitto's tooling was therefore nondeterministic, and the engines floor could be violated silently.

## Decision

1. **Tool Node.** `kitto setup`, `update --apply` and `sync --apply` resolve one absolute Node path that satisfies `engines.node` in `package.json`, independent of any project:
   - Prefer the mise global: run `mise which node` with the working directory set to `$HOME` and every `MISE_*` variable removed except the four directory locations (`MISE_DATA_DIR`, `MISE_CONFIG_DIR`, `MISE_CACHE_DIR`, `MISE_STATE_DIR`). If the versioned install directory has a sibling symlink named by a bare major number (for example `installs/node/26`), use that path so a patch upgrade does not break the record.
   - Otherwise use `process.execPath` of the running setup.
   - Each candidate must run `<path> --version` and meet the floor; a candidate that does not is skipped. If none qualifies, setup fails and names what was tried.
   - The result is stored as the top-level `state.toolNode` (`path`, `version`, `source`). It is not an ownership-ledger entry. Previews print it and never write it.
2. **Launcher.** Setup deploys `<agentsHome>/bin/kitto-node` (`~/.agents/bin/kitto-node` by default), an executable POSIX `sh` script (mode 0755) that runs `exec <recorded node> "$@"`. If the recorded node no longer exists it prints a message that tells the user to rerun `kitto setup` and exits 127. The launcher is a Kitto-owned resource of ledger kind `launcher`, scope `shared`, hashed by content. Kitto never overwrites or removes a file at that path unless the live content matches the recorded hash; a foreign or edited file is preserved with a warning, like skills. `kitto remove` deletes an owned launcher and clears `state.toolNode`.
3. **Use.** Every command that Kitto tells agents to run with Node goes through the launcher by absolute-from-home path, because hosts may not have `~/.agents/bin` on `PATH`. The Kitto maintenance skill is rendered at setup with the launcher's absolute, shell-quoted path.
4. **Floor.** The Node floor rises to the current Active LTS, `>=26.0.0` (`.node-version` is already 26). The scripts shipped inside skills are TypeScript with erasable syntax and run on this Node by type stripping.

## Out of scope

- Host CLIs (Pi, Codex, DSH) keep their own shebang and may still run on the project's Node. See the follow-up in the roadmap.
- Project Node is untouched: Kitto neither changes project version pins nor installs Node.
- Windows is not supported by the launcher (POSIX `sh`).

## Consequences

- Rerun `kitto setup` after Node is uninstalled or the mise global changes to a version without a stable major link; the launcher says so when the recorded path is gone.
- Machines on Node below 26 must install Node 26 (globally, for the mise route) before upgrading Kitto.
