# Kitto

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
