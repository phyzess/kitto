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

This is not yet an installable Kitto release. Existing sync scripts remain the supported Pi entry point.

## Next implementation stages

1. Add the npm setup entry and a minimal maintenance skill around tested operations.
2. Add native Pi, Codex and DSH integration, with explicit version and capability checks.
3. Add managed Git configuration synchronization and native update notifications.
4. Validate tarball installation, upgrades, removal and recovery on macOS and Linux before publication.

Preserve the existing personal configuration. Do not build a task scheduler, workflow engine or cross-agent session migration system.

## Known limits of the first change

- Ownership is initialized by the first successful real pull. Older removed packages cannot be identified retroactively.
- Configuration deployment is not yet a multi-file transaction. A later step failure can leave earlier files updated; repeat pull after resolving the error.
- Registry checks discover candidate versions; they do not install or certify new versions.
- Version inventory reports unresolved package locations as unknown rather than guessing.
- Source tests use fake native package-manager commands. Actual native integration and macOS results must be checked separately.
