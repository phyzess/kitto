# Kitto implementation progress

Kitto evolves this repository. The daily agent entry points remain native. pstack is outside the current scope.

## Implemented in the first change

- Read-only status and deployment previews.
- Preserve machine settings overrides during export and existing environment files during deployment.
- Track shared package ownership so removed shared packages stop loading without removing unknown local packages.
- Update MCP definitions while preserving runtime switches and explicit local overrides.
- Restrict skill and extension export to declared repository assets.
- Refuse concurrent sync writes, fail package installation before deployment, and avoid committing unrelated staged files.
- Compare the globally selected installed mise version with the declared target.
- Add a read-only version inventory with explicit online registry checks and separate release channels.
- Add isolated regression tests and Linux/macOS CI.

Existing sync scripts remain available for compatibility.

## Installation and native integration

- Add one public npm binary, `kitto setup`, and one on-demand maintenance skill. No runtime npm dependencies or lifecycle install scripts.
- Keep published code separate from personal `config/`, `skills/`, `lists/` and local/private files. An explicit npm file allowlist and tarball test enforce this.
- Clone configuration internally or reuse a checkout. Copy Kitto code out of npx's temporary directory; remember source and selected hosts for subsequent setup.
- Use global native Pi packages, Codex local marketplace/plugin commands, and a DSH bundle in the existing `web` profile. DSH contributes one provider entry, loads the body on request and disposes it with the plugin.
- Deploy shared skills once to the common native discovery location. Track content hashes, stop on local conflicts, update/remove only unchanged owned content. Do not duplicate personal skills inside the Kitto plugin.
- Fast-forward source updates only from clean tracked branches. Export writes the local checkout without commit/push. Configuration sync does not reinstall native integrations after successful setup.
- Pi self-update notices are asynchronous, stable-channel-only, limited to one short registry request per day, and optional. Other hosts use the maintenance skill for checks; there are no background services.

The npm name `kitto` was already occupied. The implementation uses `@phyzess/kitto`. This is development version `0.1.0-dev.1`, not a published package. An npm identity check returned `ENEEDAUTH` in this environment; scope ownership and publishing permission remain unverified. No login or publication was attempted.

## Recovery and detaching integrations

- Preserve the last verified working runtime through a failed upgrade and subsequent retries. Reinstalling identical code leaves that checkpoint intact; generated Python caches do not count as code changes.
- Offer preview/apply recovery through the maintenance skill. Validate the checkpoint hash, restore code and reconnect native integrations without reverting deployed personal configuration or skill ownership.
- Keep `kitto setup --recover` as the external rescue path when the installed runner is broken or the restored version predates recovery support. It uses saved installation state and does not require the configuration checkout to be present.
- Detach only Kitto's native registrations using the host commands. Preflight source ownership, record completed hosts, resume partial removal, and remove stale Kitto entries from Pi's local package cache.
- Keep shared skills, personal configuration, authentication, installed host CLIs and Kitto files. Normal sync cannot silently reinstall a detached integration; explicit setup can reinstall it.

## Validation

- Python regression suite: 23 tests for existing merge/export, dry-run and dependency behavior.
- Node regression suite: 20 tests covering setup, tarball isolation, sync/clone/fast-forward, update notices, preserved checkpoints across retries, external recovery with broken code/missing source, checkpoint tampering, resumable removal, foreign registration conflicts, DSH prerequisite checks and reinstallation.
- Native Linux checks: Pi 1.5.2 package install and actual resource-loader discovery without extension errors; Codex 0.169.0 marketplace installation, enabled plugin listing and app-server `skills/list` finding the five personal skills plus `kitto:kitto` without errors; DSH 0.2.2-rc.3 bundle composition plus actual skill registry discovery/body/disposal on both rc.1 and rc.3.
- CI runs the Python and Node suites plus a real native lifecycle test on Linux and macOS. The lifecycle installs the pinned hosts and exercises install → version change → recovery → detach → reinstall, checking native registries and DSH composition while preserving shared skills and personal overrides. It uses isolated homes, does not authenticate or call a model, and can be reproduced with `KITTO_NATIVE_BIN=/path/to/host-bins node --test tests/native.test.mjs`.
- All three native discovery paths find the five existing personal skills and exactly one Kitto maintenance skill. Pi reports no diagnostics; Codex's app-server reports no skill errors; DSH's filesystem and Kitto providers coexist without duplicates.

Validated host baselines (2026-11-14): `@earendil-works/pi-coding-agent@1.5.2`, `@openai/codex@0.169.0`, `@deepseek-ai/dsh@0.2.2-rc.1` (npm latest, prerelease), with DSH rc.3 (npm next) also tested. Setup never silently changes release channels or upgrades installed hosts. Capability/version checks reject older unsupported hosts; a newer version passing these checks is not a claim of full compatibility.

The clean CI environment exposed DSH's external pnpm prerequisite. Setup now checks it before writes and includes missing `pnpm@12.18.0` with `--install-agents`. Existing pnpm is preserved. CI installs this validated prerequisite explicitly rather than relying on developer-machine state.

pnpm 12 requires its native-binary installation script on macOS; CI enables that package's installer specifically. Native registration ownership compares physical paths, covering aliases such as macOS `/var` and `/private/var` while still refusing a different source. A real lifecycle run through a symlinked temporary root verifies this case.

Source contracts: [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md), [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins), [DSH CLI](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.3/apps/dsh), and the installed `@deepseek-ai/dsh-skill` registry API for rc.1/rc.3.

## Before a release

Verify npm publication ownership and choose the final release version. Publish only after approval. Native authenticated model execution, cross-host rule/MCP translation and automatic upgrade policy are not claimed. Installation and lifecycle tests do not certify every third-party personal skill or MCP dependency.

Preserve the existing personal configuration. Do not build a task scheduler, workflow engine or cross-agent session migration system.

## Known limits of the first change

- Ownership is initialized by the first successful real pull. Older removed packages cannot be identified retroactively.
- Configuration deployment is not yet a multi-file transaction. A later step failure can leave earlier files updated; repeat pull after resolving the error.
- Registry checks discover candidate versions; they do not install or certify new versions.
- Version inventory reports unresolved package locations as unknown rather than guessing.
- Most regression tests use stateful native-manager fixtures; the separate lifecycle test invokes actual native CLIs. Neither test suite executes authenticated model tasks.
- A successful native plugin registration does not install every tool needed by a personal skill. Configuration availability and task-specific runtime dependencies are separate.
- Global Codex shared-skill discovery fixes the common root at `~/.agents`; custom independent resource roots are rejected rather than silently losing skills.
