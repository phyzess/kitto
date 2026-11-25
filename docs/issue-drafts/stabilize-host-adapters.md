# Replace fragile host discovery and parity shortcuts

Status: filed as [#46](https://github.com/phyzess/kitto/issues/46). Each numbered item can be scheduled independently.

## 1. Resolve DSH modules through a supported native contract

`integration/scoped-dsh/native.mjs` detects mise by launcher layout and resolves DSH's installed `yaml` from the selected entry point. Wrapper path shape is not an install contract. When mise's lookup fails, the shim can still be returned and module resolution can then fail ambiguously. Keep one coherent runtime dependency set; do not switch to an unrelated `yaml` version merely to make preview pass.

**Verify:** run native adapter and scoped DSH tests with a direct install, clean mise shim, unsuccessful shim resolution, and unrecognized wrapper in a test-only `PATH`. Prefer the host-supported discovery surface where available; fail clearly without writing a profile if the selected install cannot be identified. Check preview still explains a DSH install that has not happened yet.

## 2. Derive MCP parity from structured host definitions

`lib/parity.mjs` extracts Codex table names and DSH `serverName` lines with regular expressions. These character shapes approximate native output, not all valid configuration: a Codex header with a trailing TOML comment or DSH scalar data containing a `serverName:` line can produce a false comparison.

**Verify:** create isolated config fixtures containing bare, quoted, and commented Codex keys, DSH inactive/declarative rows and scalar samples, and duplicate profile/home names. Compare the report against the native declarations or a validated non-executing parser. Assert parity checking mutates neither home and remains explicit that Desktop is global-only. Keep secret values absent from report and fixtures. See `tests/parity.test.mjs`.

## 3. Normalize version comparison and eliminate the circular import

`lib/hosts.mjs` and `lib/kitto.mjs` maintain version ordering separately, and the maintenance path imports the host command lazily because host pins live in the same module that ultimately dispatches the command. The two comparison implementations can drift. This is separate from the decision to install only pinned host versions.

**Verify:** extract shared pin data and a common, explicitly bounded comparator without changing the CLI contract. Cover release vs. prerelease, hyphenated prerelease labels, malformed versions, and both public/internal host command paths in `tests/kitto.test.mjs`. Continue verifying the installed version as an exact string and warning on an unvalidated override for both preview and apply. Justify any new dependency independently.
