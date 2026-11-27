# Contributor and agent rules for Kitto

These rules apply to developing this repository. `config/instructions/common.md` and `config/<host>/AGENTS.md` are product rules deployed to users' agents; never put repo-development rules there.

The R1 to R9 labels name recurring rework causes found in the repository history.

## Scope

- Keep one concern per PR. Split refactors, features and release chores. Do not batch many PRs into one day or touch dozens of unrelated files; rebase onto the current target before review. (R9)
- Do not clean up unrelated code or comments in a feature PR.

## Design rules

- Build preview and apply from one plan object. A preview that is a separate code path will drift from apply. Tests must assert that the preview output equals the plan apply executes. (R1)
- Compare filesystem locations with `sameLocation` from `lib/paths.mjs`, never with `===` on `resolve()` or `realpathSync()` results. Tests must run with `TMPDIR` behind a symlink. Enforced by `npm run lint:invariants` (`no-path-string-equality`). (R2)
- Parse host TOML, YAML and DSH references with the structured parser or CST helper already used in `lib/`. Do not use regular expressions on config text. Enforced in part by `npm run lint:invariants` (`no-regex-on-structured-config`, name-based, so review still applies). (R3)
- Every defensive branch must map to an in-scope threat in [ADR 007](docs/adr/007-threat-model.md). Name the threat in the PR. Do not add error handling for cases the threat model excludes.

## Evidence rules

- Do not write claims about host behavior, billing or limits into rules, docs, code or CHANGELOG without evidence. Record the command and host version that showed it in the PR. (R4)
- Changes to agent-rule text (`config/instructions/common.md`, `config/*/AGENTS.md`, `skills/*`) need a scenario table and a dry run. Follow `.agents/skills/rule-eval/SKILL.md`. Do not patch rule text repeatedly after live runs. (R5)

## Versions and tests

- Keep host version baselines only in `lib/host-pins.mjs`. Do not repeat a version literal elsewhere. Enforced by `npm run lint:versions`. (R6)
- Do not depend on the environment in tests or CI: no fixed timeouts that fail under parallel load, no immediate reads after npm publish (poll with a bound), no bash 4 features or `errexit` assumptions (macOS ships bash 3.2). Keep timeouts generous and name the reason. (R7)
- When a change alters behavior or state shape, also update tests that only run in CI with real host CLIs (`tests/native.test.mjs`, `tests/scope-codex.test.mjs`, `tests/scope-dsh.test.mjs`, `tests/dsh-routing.test.mjs`); they skip locally, so read them. Run bash snippets under macOS `/bin/bash` 3.2 (brace `${var}` before non-ASCII text). Learned from rework in PRs #59 and #64. (R7)
- Put every test in `tests/*.test.mjs`; `npm test` globs them. Enforced by `npm run check:test-wiring`. (R8)
- A change to behavior needs a test that fails without it.

## Comments

- New code comments are ratcheted. Put intent in names and tests, decisions in ADRs. Read `docs/comment-policy.md` before adding a comment. Enforced by `npm run lint:comments`.

## Verify before PR

Run from the repository root with `npm ci --ignore-scripts` done. Use the full 40-character SHA of the target branch tip for `<base>` and of `HEAD` for `<head>`.

```sh
node scripts/check-comments.mjs --base <base> --head <head>
npm run lint:versions
npm run check:test-wiring
npm run lint:invariants
npm test
python3 -m unittest discover -s tests -v   # while Python tests exist
```

Update the `Unreleased` section of `CHANGELOG.md` with one line. Fill in `.github/pull_request_template.md`. For a pre-PR walk-through use `.agents/skills/kitto-change-preflight/SKILL.md`.
