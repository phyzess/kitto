# Remove the pnpm-only CI rebuild when a native install is available without scripts

Status: filed as [#49](https://github.com/phyzess/kitto/issues/49).

## Context and goal

The original workflow's JS install step ran npm with `--ignore-scripts`, then selectively rebuilt pnpm because the pinned pnpm 12 installation left a shell placeholder on macOS. This policy and command order remain in `scripts/ci-install-native.mjs`; the two original comment tokens are recorded in the [ledger](../comment-audit.md). The rebuild is an extra install step that executes pnpm lifecycle code and depends on package layout.

## Scope and constraints

Evaluate a verified native packaging path or an upstream version that works without the rebuild. Do not enable lifecycle scripts for other packages, change any host pins as part of the audit, or assume Linux results cover macOS. Keep the host binary versions pinned and verified.

## Acceptance and verification

- On the Ubuntu and macOS CI matrix, a fresh isolated host install with scripts disabled yields a working `pnpm --version` with the exact pinned version; the pinned Pi, Codex, and DSH CLIs also resolve under the test prefix.
- Compare clean runs with the current installer and the proposed script-free path. Assert no dependency lifecycle step runs in the new path and run the native host test job. Verify on macOS that the binary does not depend on the shipped shell placeholder's postinstall mutation.
- Remove the rebuild only after the replacement passes both matrix legs. If it needs a pin change or supplier approval, record that as a dependency rather than loosening install policy.
