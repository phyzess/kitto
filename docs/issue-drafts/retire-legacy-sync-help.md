# Decouple legacy Pi sync help from source line numbers

Status: obsolete — implemented by the comment audit; not filed.

## Context and goal

At the [audit baseline](../comment-audit.md), `sync.sh:63` implements `--help` by printing physical lines 2–25 of the script. This coupling turns an apparently inert header into executable CLI output. Even a comment-only edit above the retained range can change the help without touching argument parsing.

## Scope and constraints

Use explicit legacy usage data, not source extraction. Preserve the legacy command/flag parser, messages and deprecated direct-entry compatibility; retiring the shell adapter itself is separate. Do not broaden permissions or run `pull`/`push` to exercise help.

## Acceptance and verification

- In a temporary home, capture stdout and exit status from `bash sync.sh status --help`, then change only preceding source line layout in a temporary copy. The old implementation's output changes; the replacement remains stable and equals the baseline help for an unmodified file.
- Help needs no host, creates no destination, and returns before the direct-entry deprecation warning. The audit independently checks both flags against the original output and runs the existing `tests/test_sync.py` suite.

The [ledger](../comment-audit.md) records each former source comment as migrated to literal usage data, and [ADR 001](../adr/001-configuration-and-host-boundaries.md) records the compatibility decision.
