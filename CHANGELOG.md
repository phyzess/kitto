# Kitto

## Unreleased

- Scope lifecycle: add `kitto scope list [--json]` and `kitto scope remove --global|--workspace|--workspace-parent`. Removal canonicalizes paths with realpath (falling back to an absolute path), reuses the setup lock, and only unregisters a scope: instructions, skills, host adapters and user files are never deleted. Setup and removal share one validated atomic registry writer (temp file + rename, mode 0600) that preserves unknown top-level fields.
- DSH: report missing CodeGraph indexes in `status`, and initialize registered scoped workspaces during `setup` when the CodeGraph CLI is available. General `sync`/`deps`/`export` never write indexes; set `KITTO_NO_CODEGRAPH_INIT=1` to keep setup report-only.
- DSH/Codex: make the Codex `i-have-adhd` skill model-invocable (`allow_implicit_invocation: true`), align its startup instruction with DSH, and support a custom `DSH_HOME` in the fallback path.
- Skills: replace deployed skill directories with a temp directory and rename, so an interrupted sync cannot leave a half-copied tree that is permanently reported as a conflict.
- Pi export: stage newly added managed extensions and skills with `git add -A` so a new file is committed, not silently left untracked.
- Docs: add a Pi/Codex/DSH capability matrix and the manual steps that remain in a one-command migration.
- Status: report MCP names per selected host and the servers missing on each host; read-only, no host writes.
- DSH: warn when a registered workspace is not writable by the current user, so agents do not fail later on `.codegraph`, `.pi` or file edits.
- Config: make the DSH `i-have-adhd` skill model-invocable and make the session-start instruction explicit.
- Config: correct CodeGraph MCP tool names, add the DSH `mcp__codegraph__*` and `projectPath` guidance, and mark `codegraph affected` as CLI-only.
- Config: stop claiming Hindsight auto-loads in DSH; document manual recall and the optional `atlas/` layers.
- Export: only repository-declared settings keys and MCP servers travel upstream; machine-only entries are previewed and skipped, credential-shaped keys are dropped, and literal token shapes refuse the export.

## 0.2.1

- Select hosts with arrow keys and Space in the setup wizard, then choose a configuration source and preview or apply the plan. Scripted input remains supported.
- Use the pinned i-have-adhd skill in the default Codex and DSH configuration alongside the existing Pi extension.

## 0.2.0

- Guide users through host selection, configuration sources, dependencies, preview and installation in one interactive setup.
- Share global and workspace instructions and skills across Pi, Codex and DSH, including workspaces created after setup.
- Configure an active DSH system service under its own account from the same wizard.
- Preserve conflicting unowned skills during guided setup and subsequent synchronization.

## 0.1.1

- Document setup, synchronization and tag-pinned configuration for Pi, Codex and DSH.
- Use Node.js 26 LTS for release checks and CI.
- Validate, tag and publish release snapshots with `npm run release`.
- Allow switching configuration tags when the Kitto home path uses a filesystem alias.

## 0.1.0

- Pin the Pi extensions and Context7 package used by the configuration snapshot.
- Record the configured and last deployed revisions, and switch managed checkouts to explicit Git tags.
- Declare tools in the configuration repository and report shared versus machine-local changes.

- Scope configuration validation and prerequisites to the selected agent. Codex and DSH maintenance no longer needs Python or Pi files.
- Sync user rules and host-specific skills for Codex and DSH. Remember the selected DSH CLI profile.
- Plan tool dependencies from enabled Pi MCPs and shared skills. Give optional CodeGraph workflows a native-tool fallback.
- Report selected host versions, native plugins and bundles, and the actual configured MCP launch versions.

- Resume a Kitto-owned checkout after a failed first setup.
- Summarize dependency readiness and report incomplete managed installs.
- Keep the last working code checkpoint through failed installation retries.
- Add previewable code recovery and resumable native integration removal.
- Keep personal configuration, shared skills and installed agent CLIs in place.
- Provide `setup --recover` when the installed maintenance runner cannot start.
- Check DSH's pnpm prerequisite before writes; install it when missing with `--install-agents`.
- Recognize native registration paths through filesystem aliases without weakening foreign-source checks.

## 0.1.0-dev.0

- Add global setup and an on-demand maintenance skill for Pi, Codex and DSH.
- Reuse the Pi configuration merge/export implementation and version inventory.
- Keep personal configuration outside the distributable npm package.
- Preserve native launch commands; do not start background services.
