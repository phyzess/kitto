# Contributor and agent rules for Kitto

These rules apply to developing this repository. `config/instructions/common.md` and `config/<host>/AGENTS.md` are product rules deployed to users' agents; never put repo-development rules there.

The R1 to R9 labels name recurring rework causes found in the repository history.

## Scope

- Keep one concern per PR. Split refactors, features and release chores. Do not batch many PRs into one day or touch dozens of unrelated files; rebase onto the current target before review. (R9)
- Do not clean up unrelated code or comments in a feature PR.

## Design rules

- Build preview and apply from one plan object. A preview that is a separate code path will drift from apply. Tests must assert that the preview output equals the plan apply executes. (R1)
- Compare filesystem locations with `sameLocation` from `lib/paths.ts`, never with `===` on `resolve()` or `realpathSync()` results. Tests must run with `TMPDIR` behind a symlink. Enforced by `npm run lint:invariants` (`no-path-string-equality`). (R2)
- Parse host TOML, YAML and DSH references with the structured parser or CST helper already used in `lib/`. Do not use regular expressions on config text. Enforced in part by `npm run lint:invariants` (`no-regex-on-structured-config`, name-based, so review still applies). (R3)
- Every defensive branch must map to an in-scope threat in [ADR 007](docs/adr/007-threat-model.md). Name the threat in the PR. Do not add error handling for cases the threat model excludes.

## Evidence rules

- Do not write claims about host behavior, billing or limits into rules, docs, code or CHANGELOG without evidence. Record the command and host version that showed it in the PR. (R4)
- Changes to agent-rule text (`config/instructions/common.md`, `config/*/AGENTS.md`, `skills/*`) need a scenario table and a dry run. Follow `.agents/skills/rule-eval/SKILL.md`. Do not patch rule text repeatedly after live runs. (R5)

## Versions and tests

- Keep host version baselines only in `lib/host-pins.ts`. Do not repeat a version literal elsewhere. Enforced by `npm run lint:versions`. (R6)
- Do not depend on the environment in tests or CI: no fixed timeouts that fail under parallel load, no immediate reads after npm publish (poll with a bound), no bash 4 features or `errexit` assumptions (macOS ships bash 3.2). Keep timeouts generous and name the reason. (R7)
- When a change alters behavior or state shape, also update tests that only run in CI with real host CLIs (`tests/native.test.mjs`, `tests/scope-codex.test.mjs`, `tests/scope-dsh.test.mjs`, `tests/dsh-routing.test.mjs`); they skip locally, so read them. Run bash snippets under macOS `/bin/bash` 3.2 (brace `${var}` before non-ASCII text). Learned from rework in PRs #59 and #64. (R7)
- Vitest runs with `isolate: false` (a worker reuses its module state across test files; this keeps the suite as fast as node:test was). Restore every process-global change a test makes — `process.env`, `console.*`, `globalThis.*`, module-level flags — in `finally` or `t.onTestFinished`. Mutate globals inside spawned child processes (preload scripts) where possible. (R7)
- Put every test in `tests/*.test.mjs`; `npm test` (Vitest via `vp test run`) runs them; `vite.config.mjs` holds the include pattern. Write tests with `import { test } from 'vitest'`, not `node:test`. Run one file with `npx vp test run tests/<name>.test.mjs`. Enforced by `npm run check:test-wiring`. (R8)
- A change to behavior needs a test that fails without it.

## Comments

- New code comments are ratcheted. Put intent in names and tests, decisions in ADRs. Read `docs/comment-policy.md` before adding a comment. Enforced by `npm run lint:comments`.

## Sources and build

- Runtime sources in `bin/`, `lib/` and `integration/` are `.ts` files that use erasable TypeScript syntax only (no enums, namespaces or parameter properties), so Node type stripping runs them. Import siblings with the `.ts` extension. Tests, `scripts/` and `vite.config.mjs` stay `.mjs`.
- The published package is `dist/`, built by `npm run build` with `.mjs` output. Hosts, the installed runtime and `$KITTO_HOME/runtime` only ever see `.mjs`; strings that name runtime files (for example `integration/scoped-pi/index.mjs`) stay `.mjs`. Do not run `npm pack` or `npm publish` from the repository root; `npm run release` packs `dist/`.
- From a source checkout use `./setup.sh` (it runs `npm ci --ignore-scripts` when needed and `npm run build`, then `node dist/bin/kitto.mjs`). `node bin/kitto.ts` works for quick local runs, but installing a runtime from a directory that holds `.ts` entries is refused.
- Tests that install a runtime or spawn the CLI use `dist/`; run `npm run build` before `npm test`.

## Types and lint

- `npm run typecheck` runs `tsc` with `noImplicitAny` over `bin/`, `lib/`, `integration/` and `types/` (including `types/conformance.ts`). Annotate every parameter; put module-owned types in the module that owns them and keep only cross-cutting shapes in `types/kitto.d.ts`. Use `import type`/`export type` and erasable syntax only (`erasableSyntaxOnly` and `verbatimModuleSyntax` are on). Comments are ratcheted, so do not add JSDoc, `@ts-check`, `@ts-nocheck` or `@ts-expect-error`.
- `npm run lint:ox` runs oxlint (correctness rules). Fix the finding or turn the rule off in `.oxlintrc.json` with a reason in the PR.

## Verify before PR

Run from the repository root with `npm ci --ignore-scripts` done. Use the full 40-character SHA of the target branch tip for `<base>` and of `HEAD` for `<head>`.

```sh
node scripts/check-comments.mjs --base <base> --head <head>
npm run lint:versions
npm run check:test-wiring
npm run lint:invariants
npm run typecheck
npm run lint:ox
npm run build
npm test
python3 -m unittest discover -s tests -v   # while Python tests exist
```

Update the `Unreleased` section of `CHANGELOG.md` with one line. Fill in `.github/pull_request_template.md`. For a pre-PR walk-through use `.agents/skills/kitto-change-preflight/SKILL.md`.
