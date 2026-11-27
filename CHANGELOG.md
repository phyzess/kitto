# Kitto

## Unreleased

- Maintenance: add contributor rules (`AGENTS.md`), ast-grep invariant checks (`npm run lint:invariants`, also a CI step), a PR template, repo-local preflight and rule-eval skills, and the proposed threat-model ADR 007.
- Internal: add an ownership ledger module and a state schema 2 migration with rollback ([ADR 008](docs/adr/008-ownership-ledger.md)). Nothing uses them yet and no state is migrated.
- Maintenance: retire the one-time comment-ratchet rollout bootstrap, closed issue drafts, the progress log and the comment audit ledgers (kept in git history at `fb9e292`).
- Tests: `npm test` now runs every `tests/*.test.mjs`, and `npm run check:test-wiring` (also a CI step) fails if a test file is not covered.
- Paths: compare filesystem locations by identity through the shared `sameLocation` helper instead of resolved strings, so symlinked roots such as macOS `/var` are no longer mistaken for different locations. CI now also runs the test suites with `TMPDIR` behind a symlink.
- Locks: `sync.sh` now tells a live, provably exited and unverifiable lock owner apart, so a process owned by another user is reported as running and no manual removal is suggested when ownership cannot be verified.
- Maintenance: keep every host baseline, the routing-validated DSH version and pnpm in `lib/host-pins.mjs`, and add `npm run lint:versions` to reject repeated literals. CI installs read the same source.

### Breaking

- Remove `kitto route preflight`, `kitto route reselect` and `kitto route audit`. Use `kitto route plan` and `kitto route check` for task routing, and `kitto route permit` for the controlled DSH `subagent` path.
- Remove legacy compatibility. `sync.sh` can no longer be run directly (the deprecated direct-use warnings, `KITTO_ALLOW_LEGACY_SKILL_SYNC` and the direct skill sync are gone). A configuration source without `config/instructions/common.md` is rejected for every host instead of falling back to whole-file or addendum-only deployment, and `pi_config.py legacy-agents` is removed. Dependency rules come only from `config/dependencies.json`; the built-in rules and `lists/*.txt` are no longer read, and a missing manifest means no declared dependencies.
- Remove `kitto route migrate --apply-fixture` and `--rollback-fixture`. `kitto route migrate --home DIRECTORY` remains a read-only preview.

## 0.4.0

- Task routing: choose models and reasoning effort per task across DSH, Pi, and Codex. Reuse role preferences, group unresolved choices, and defer work without launching its dependants. Metered routes require explicit task authorization. (#56)
- DSH: stage AgentTeams before routing preflight and recheck the exact runnable scope after edits. Web **Approve & Run** does not invoke the checker; it remains a separate pre-launch verification step. The opt-in native `subagent` permit is unchanged. (#56)
- Add `kitto route plan` and `kitto route check`, a Pi native route picker, and a Codex Plan-mode decision prompt. (#56)
- Add a DSH delivery audit skill to distinguish unavailable workspace audit evidence from missing candidate files.

## 0.3.4

- DSH routing: add offline preflight, bounded read-only reselection and reviewer independence checks. On DSH Web `0.2.2-rc.5`, operators can opt in to a one-use permit for the default native `subagent` spawn path. Native approval and allowlist checks still apply; failures are not replayed.
- Go quota: hold a verified paid pool across local sessions and processes after an operator records a verified quota failure. A hold needs an authoritative reset or explicit reauthorization; a model switch or elapsed time does not clear it.
- Migration: preview managed changes and identify fallback settings for manual review without editing the active profile. Apply and rollback are available only for isolated fixtures.
- CI: add a credential-free native fixture gate for the exact `0.2.2-rc.5` routing path. The general `0.2.2-rc.2` host baseline is unchanged. The gate uses fixture inference and activation services; it does not cover AgentTeams approval or recovery, `subagent_fork`, workflows, or direct API/JEV calls.

## 0.3.3

- OpenRouter: use exact catalog metadata instead of inferring model capabilities from similar IDs. Validate live metadata and saved snapshots before using them. (#44)
- Pi: restore native hardware and software cursor rendering, including ANSI styling. Sync replaces the old renderer override. (#45)
- Hosts: improve DSH installation discovery and compare structured MCP declarations from Codex and DSH. Share host pins and SemVer ordering. (#46)
- DSH usage: report incomplete totals explicitly and preserve valid records recovered from damaged logs. (#47)
- JEV: reject conflicting stdin sources before reading input, use the supported DSH credential parser, and omit HTTP error bodies from diagnostics. (#48)
- CI: install the pinned platform-native pnpm with lifecycle scripts disabled, without a rebuild. (#49)

## 0.3.2

- Locks: the installation lock (`$KITTO_HOME/.lock`) and the Pi adapter's write lock (`<configuration source>/config/pi/local/.sync-lock`) now record their owner — `owner.json` with pid, host, start time and command, or a `pid` file. A refused acquisition therefore reports whether the holder can still exist: `pid N started … is still running`, or `pid N is no longer running` with the statement that the lock is stale. `--break-lock` on `setup`/`update` clears a lock only when its recorded owner is provably gone and never displaces a live operation; a lock without an owner record (an older Kitto, or a hand-made directory) is left for manual inspection. Held locks are released on `SIGINT`/`SIGTERM`, which bash's `EXIT` trap alone never covered for the Pi adapter.
- Runtime: a failed deployment now says that the refreshed runtime stays unverified (`state.pendingRuntime`) and names both ways forward — rerun `update --apply`, or `setup --recover` to return to the previous runtime.
- Interpreter probes: `checkPiTools` used an 8s ceiling while the version check rode `run()`'s 600s default, so a version-manager shim (pyenv, asdf, mise) that is slow on its first run aborted the deployment after the runtime swap had already happened. The probe now separates missing, slow and failed: a slow shim warns and continues, while a missing or pre-3.10 interpreter still fails before any write. Docs describe the lock and probe semantics, and tests cover a stale installation and sync lock cleared by `--break-lock`, a live lock that `--break-lock` must refuse, and a stalling `python3` shim that warns instead of stranding the deployment.

## 0.3.1

- Hosts: a selected host CLI below the tested baseline no longer blocks `setup` or `update`. The version check reports a warning and continues, and each native integration is gated on a capability probe instead of a version comparison (`codex plugin`, `dsh plugin`), so a stale Codex or DSH CLI skips only its own registration while rules, skills and MCP still deploy — for that host and for every other selected host. An unreadable `--version` warns instead of throwing; a missing binary stays fatal because no integration can run. `--require-baseline` restores the previous strict gate for release verification, and `installMissingHosts` still verifies the version it installed itself. Docs record that the baseline is an advisory label and the `kitto hosts --apply` target, not a write precondition.

## 0.3.0

- Hosts: add the explicit `kitto hosts [--check|--apply] [--host NAME] [--version VERSION]` command for host-CLI upgrade policy (also exposed as the maintenance runner's `hosts` operation). It lists each selected host's installed `--version`, Kitto's validated baseline (`hosts[name].version`) and the exact native-manager command; `--check` is the default and writes nothing. `--apply` installs only the pinned target through `npm install --global <package>@<version>` — Pi and Codex through their npm packages, the DSH CLI through `@deepseek-ai/dsh@<baseline>` with a prerelease baseline kept exact — never `npx`, dist-tags or "latest", never an unselected host, and never automatically. Hosts already newer than the baseline are not downgraded implicitly; `--version` accepts one exact version for one host and warns in check and apply when it is not the validated baseline. The app-managed `desktop` DSH profile (matched case-insensitively) is reported and skipped, not npm-installed. Missing npm, unreadable host versions, permission failures (with npm-prefix/sudo guidance) and post-install verification mismatches fail with actionable errors before or without writing `state.json`; a multi-host failure reports which hosts changed and which did not. `kitto update` is unchanged: it prints host versions/baselines and never upgrades a host.
- Docs: add `docs/roadmap.md` for the deferred DSH Desktop deep-support TODO: controlled writes of Kitto-owned rows in `profiles/desktop/cordis.patch.yml` (with full-App-exit, restore and HMR/watch race guardrails plus macOS verification), Desktop built-in CLI detection/use, and bundle/package/lockfile ownership boundaries, including acceptance criteria, risks and non-goals. v1 stays global-only; the roadmap promises no dates and changes no behavior. Linked from the README and usage guide; the maintenance skill now points at `kitto hosts`.
- Instructions: add `config/instructions/common.md` as the shared rules layer for Pi, Codex and DSH (language, read-only review, preserving existing changes, confirming publish/external/irreversible operations, verification, tool availability/CodeGraph, session-start `i-have-adhd`/`hindsight` loading). `config/<host>/AGENTS.md` now holds only host-specific addenda. Codex and DSH compose the shared layer with their addendum inside the existing Kitto block (block-external content and local-edit protection unchanged); the Pi adapter composes shared rules plus the Pi addendum into `$PI_CODING_AGENT_DIR/AGENTS.md` and keeps its whole-file deployment, so a legacy whole-file AGENTS.md is replaced once without duplicating the shared rules. Both composers normalize a UTF-8 BOM and CRLF to canonical LF, produce identical bytes, and insert an explicit `<!-- kitto:host-addendum -->` boundary between the shared layer and the addendum. `sync.sh push` validates and stages the Pi addendum before writing the repository, splits only at that boundary, requires the shared section to equal the current common layer exactly (so deleting a trailing line or a whole section cannot leak shared rules upstream), refuses a composition without the boundary, and exports only the addendum; configuration checkouts without `config/instructions/common.md` keep the legacy whole-file behavior, except that a legacy push now refuses a deployed file carrying the shared-layer boundary instead of copying it into the addendum. Docs describe the layer, composition, env-controlled paths and push semantics.
- MCP credentials: DSH and Codex sync now accept reference-only credentials. stdio `env` and HTTP `headers` values must be a whole `${VAR}`; `Authorization` may instead use `Bearer ${VAR}`. DSH maps each reference to the mcp-client `${credential:VAR}` template and sets `expandTemplates: true` on that row, so the credentials provider resolves it at runtime and the patch never contains the secret; a native `dsh --dump-config` test proves the rows load. Codex maps a single HTTP `Authorization: Bearer ${VAR}` to `codex mcp add ... --bearer-token-env-var VAR`, recording only the variable name in its ownership fingerprint. Literal values, literal token shapes (the same patterns the Pi export guard refuses), partial/composed templates and templates in `url`/`command`/`args` skip the whole server with a reason that names only the key path or token type; no value is logged. URLs carrying userinfo (`user:pass@host`) or a credential-like query/fragment parameter (token/key/secret/password/sig/signature/auth/credential/bearer/apikey/access_token/refresh_token), and commands/arguments containing a credential-shaped flag (including `--header`/`-H` followed by a sensitive header name or credential value), env assignment or literal Authorization value, are rejected before they reach a host configuration. Native Codex errors no longer append argv to the message, so a failed add cannot echo a credential. Codex still skips stdio `env`, other headers, `env_http_headers` and `bearer_token_env_var` because `codex mcp add --env` cannot express them without writing the literal, and now warns about every skip during apply as well as in the plan.
- DSH baseline: raise the validated host baseline and `package.json` engines range to `0.2.2-rc.2`, the first mcp-client release with credential templates. The new prerelease-aware baseline comparison rejects an installed `0.2.2-rc.1` during setup instead of silently syncing templates that host ignores, and `--install-agents` now pins `0.2.2-rc.2` (an already-installed newer build still passes the check).
- MCP sources: `config/pi/mcp.private.json` and `config/pi/local/mcp.json` are read for DSH/Codex sync only when the new global `setup`/`update` option `--include-private` is set; the default stays base+platform so machine-specific servers and credentials do not spread accidentally. The choice is remembered in `state.json` (`includePrivate`), later `setup` runs without the flag keep it, and `--no-include-private` turns it off. Precedence is base < platform < local < private, both files are optional, and entries still carrying `YOUR_*` placeholders are skipped instead of syncing a template URL. Scoped setup rejects the new options because it does not sync MCP servers.
- Docs/tests: the capability matrix and manual-migration steps describe which host/transport supports references and which still needs native configuration; unit coverage adds DSH template mapping/literal refusal/URL/command credential refusal/private opt-in/removal and Codex bearer argv, skip warnings, literal-secret/URL/command refusal, private opt-in, argv-safe failure messages and the persisted `--include-private` CLI flow. `tests/native.test.mjs` now runs a real Codex 0.170.0 and DSH 0.2.2-rc.2 against a reference-only fixture (bearer env var, DSH credential templates, dump-config load and removal).
- Entry points: `setup.sh` now always delegates to `kitto setup` (interactive, non-interactive and `--dry-run` alike), so a non-TTY run no longer executes the old `sync.sh deps` + `sync.sh pull` Pi path. `--force` is deprecated: it prints one warning and keeps its historical non-interactive meaning (the wizard cannot start, even in a TTY). `sync.sh` remains the internal Pi adapter used by `lib/kitto.mjs`, but direct runs print a deprecated-entry warning and skip shared `~/.agents/skills` deployment unless `KITTO_ALLOW_LEGACY_SKILL_SYNC=1` is set explicitly; direct `status` no longer reports those skipped skills as missing/differs, while Pi settings, MCP, `AGENTS.md`, extensions and packages still work for compatibility. Docs now recommend one setup entry, `--source .` for a source checkout without state, describe the changed `--dry-run` preview and the shared-skill opt-in.
- Update: add the public `kitto update [--check|--apply]` command (default preview; `--check` is the explicit form; the maintenance runner also accepts it). Apply fetches and fast-forwards a clean tracked source branch; a local branch that is ahead of (or equal to) its remote is allowed, and only true divergence (neither commit is an ancestor of the other) is refused before any change. It then refreshes the installed runtime copy from the executing Kitto package through the existing checkpointed swap, then deploys configuration, skills and MCP. The replaced runtime stays pending until the deployment succeeds: a failed update neither verifies it nor becomes the recovery checkpoint, so a retry or `setup --recover` returns to the last successfully deployed version. Preview writes nothing. Dirty worktrees, detached/tag checkouts, missing upstreams and non-fast-forward remotes stop before any write with actionable errors. `state.json` now records `sourceUrl` and `sourceRef` (branch or tag, written at setup and after tag switches) and follows a changed origin; a lost managed checkout is re-cloned only on the recorded branch — tags, unknown refs and non-Git URLs are never guessed and instead explain how to recreate the checkout in place or use a new `KITTO_HOME`. Older state files are backfilled from the bootstrap marker and keep working. Host CLIs are never upgraded: update prints installed and tested-baseline versions and points at each host's native manager. The running process finishes its deployment with the code it started with; later Kitto calls and restarted hosts use the refreshed runtime.
- DSH Desktop: allow `--dsh-profile desktop` (and the same value in the setup wizard) in a global-only mode. Kitto deploys `$DSH_HOME/AGENTS.md`, `$DSH_HOME/skills` and shared `~/.agents/skills`, but never runs `dsh plugin --profile desktop add/remove`, requires pnpm or a local dsh CLI, writes `profiles/desktop/cordis.patch.yml`, registers a scope adapter or syncs the MCP home patch for it. `--install-agents` never installs the npm dsh CLI for this profile. A best-effort probe copies the profile manifest to a scratch `DSH_HOME` (the real profile is not touched), skips the probe when the manifest is missing and distinguishes the npm CLI, an initialized in-app CLI, timeouts and missing CLIs with actionable guidance. Scoped setup rejects the app-managed profile, `--dsh-service` and shared-rules-only mode (or skips desktop while configuring other hosts), MCP parity marks DSH as global-only, and removal no longer looks for a bundle Kitto never installed. Web/headless behavior is unchanged.
- Scope lifecycle: add `kitto scope list [--json]` and `kitto scope remove --global|--workspace|--workspace-parent`. Removal canonicalizes paths with realpath (falling back to an absolute path), reuses the setup lock, and only unregisters a scope: instructions, skills, host adapters and user files are never deleted. Setup and removal share one validated atomic registry writer (temp file + rename, mode 0600) that preserves unknown top-level fields.
- DSH: sync the repository's portable Pi MCP servers into `$DSH_HOME/cordis.patch.yml` as `kitto-mcp-*` rows during `setup` and `sync`, preserving unrelated YAML lines, comments and `!!js` (Kitto rows are appended in source order). Servers with literal `env`/`headers`, and names already declared by the home patch, a profile patch or an enabled `mcp-manager` entry are skipped with a warning; private/local Pi files are read only with `--include-private`. Generated YAML is validated before writing (a trailing `...` is kept as the document end); non-empty flow-style patches and mixed Kitto `insert` items abort without writing. `maintain remove` deletes the Kitto rows, or keeps an unreadable patch with a warning; set `KITTO_NO_MCP_SYNC=1` to opt out.
- Codex: sync enabled Pi MCP servers through `codex mcp list/get/add/remove`. Record a pending fingerprint before each native write and adopt it after an interrupted save or a post-write OAuth timeout, reconcile pending-only records when their source disappears, prune stale ownership when a live server disappears, preserve unowned or locally changed servers, skip the env/header forms Codex cannot express safely (only an HTTP `Authorization: Bearer ${VAR}` maps to `--bearer-token-env-var`), skip OAuth/tool-filter fields, use a scratch `CODEX_HOME` for read-only probes, and remove only unchanged Kitto-owned servers when detaching.
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
