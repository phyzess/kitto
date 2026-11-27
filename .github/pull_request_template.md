## Summary

<!-- What changes and why, in a few lines. -->

## Checklist

- [ ] One concern per PR; no unrelated cleanup.
- [ ] Preview and apply share one plan (no separate code path for each).
- [ ] Filesystem locations compared with `sameLocation`, structured config parsed with a parser.
- [ ] Defensive branches map to a threat in `docs/adr/007-threat-model.md`.
- [ ] Claims about host behavior, billing or limits cite evidence: command and host version.
- [ ] Agent-rule text changed (`common.md`, `config/*/AGENTS.md`, `skills/*`): scenario table with trigger scenarios and counter-examples below, dry-run outcome recorded.
- [ ] `CHANGELOG.md` Unreleased updated.
- [ ] Verification run (list results): `lint:comments` with full SHAs, `lint:versions`, `check:test-wiring`, `lint:invariants`, `npm test`, python unittest.

## Evidence

<!-- Commands, host versions, outputs. -->

## Rule scenarios (agent-rule changes only)

| Situation | Expected first reply or behavior | Counter-example |
| --- | --- | --- |
