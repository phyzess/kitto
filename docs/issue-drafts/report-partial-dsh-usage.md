# Identify incomplete DSH usage totals instead of silently undercounting

Status: filed as [#47](https://github.com/phyzess/kitto/issues/47).

## Context and goal

`skills/context-budget/scripts/dsh-usage.mjs` uses newline-delimited Zstd session logs as its usage source. It catches malformed selected records, suppresses decompression stderr and resolves once stdout closes without checking the child's non-zero exit. An interrupted active log should not abort every other session, but a corrupt file can resemble a clean low-usage result.

## Scope and constraints

Differentiate incomplete input, malformed completed records, and decompression failures. Keep output free of raw session content; do not open real personal logs in automated tests. Retain read-only operation and clearly label recovered counts or omitted files.

## Acceptance and verification

- Generate temporary session directories with a valid compressed log, a malformed complete JSON record followed by a good usage record, and an incomplete or failed Zstd stream. Run the audit with `DSH_HOME` pointing there and assert clean and partial totals are distinguishable, good rows remain available, and no input files change.
- Document the partial-status representation for both human output and `--json`. Assert no raw message text appears in diagnostics and a missing decompressor remains an actionable failure rather than a clean total.
