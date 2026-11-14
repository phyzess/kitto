# Kitto

## 0.1.0-dev.1

- Keep the last working code checkpoint through failed installation retries.
- Add previewable code recovery and resumable native integration removal.
- Keep personal configuration, shared skills and installed agent CLIs in place.
- Provide `setup --recover` when the installed maintenance runner cannot start.
- Check DSH's pnpm prerequisite before writes; install it when missing with `--install-agents`.

## 0.1.0-dev.0

- Add global setup and an on-demand maintenance skill for Pi, Codex and DSH.
- Reuse the Pi configuration merge/export implementation and version inventory.
- Keep personal configuration outside the distributable npm package.
- Preserve native launch commands; do not start background services.
