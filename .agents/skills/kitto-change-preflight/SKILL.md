---
name: kitto-change-preflight
description: Run the pre-PR checks and self-review for a change to the Kitto repository.
---

# Kitto change preflight

Use this skill at the Kitto repository root before opening or updating a PR. It reads `AGENTS.md`; the R1 to R9 labels below refer to the rules there. Do not push or open the PR as part of this skill.

## 1. Scope and size

- Confirm the diff has one concern: `git diff --stat <base>...HEAD`. Split the PR if it mixes features, refactors and release chores, or touches many unrelated files.
- Rebase onto the current target branch. Do not review against a stale base.

## 2. Run the checks

Record the full 40-character SHA of the target branch tip (`<base>`) and of `HEAD` (`<head>`). Run one command at a time.

```sh
npm ci --ignore-scripts
node scripts/check-comments.mjs --base <base> --head <head>
npm run lint:versions
npm run check:test-wiring
npm run lint:invariants
npm test
python3 -m unittest discover -s tests -v
```

Skip the Python line only if no Python tests remain. On a loaded machine, run the targeted test files for the change first, then the full suites. A failure under load is a test defect (R7): fix the hidden assumption, do not raise the timeout without a reason.

## 3. Self-review questions

- R1: Do preview and apply consume the same plan? Is there a test asserting they agree?
- R2: Are filesystem paths compared by identity (`sameLocation`), including through a symlinked `TMPDIR`?
- R3: Is any TOML, YAML or DSH reference parsed with a regular expression instead of the structured helper?
- R4: Does any new text claim host behavior, billing or limits? Is the command and host version recorded?
- R5: Did agent-rule text change? If so, follow `.agents/skills/rule-eval/SKILL.md`.
- R6: Does any host version literal appear outside `lib/host-pins.mjs`, including docs and workflow files?
- R7: Do new tests or CI steps assume timing, network consistency, bash 4 or a particular home directory?
- R8: Is every new test file under `tests/*.test.mjs`?
- Threat model: Does each new defensive branch map to an in-scope threat in `docs/adr/007-threat-model.md`?

## 4. Documents

- Add one line to `CHANGELOG.md` under Unreleased.
- Search README, `docs/` and ADRs for statements the change makes stale, especially version numbers and command names.
- Fill in `.github/pull_request_template.md` with evidence and verification results.

## 5. Report

State the base and head SHAs, each command with its result, anything skipped and why, and open doubts. Claim readiness only if every command passed.
