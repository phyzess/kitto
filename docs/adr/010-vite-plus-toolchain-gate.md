# ADR 010: One toolchain gate through Vite+

Status: accepted.

## Context

The Vite+ pieces were adopted at different times: oxlint and `tsc` type checking came first, then `vp pack` (build), `vp test` (Vitest), and finally Oxfmt. Two consequences were left in place:

- Lint and type check never moved under `vp`. `lint:ox` ran the standalone `oxlint` binary, pinned at a version different from the one `vite-plus` bundles, and `typecheck` ran `tsc` next to a `vp check` that was documented but not used.
- CI ran format, lint and type checks as three separate steps, so nothing exercised the composite command that Vite+ ships for exactly this.

The build determinism question is related: the Vite+ feasibility spike observed that one build in six produced a different `dist` hash, differing only in the order of consecutive `node:` imports inside a chunk. That was addressed in code, not in process.

## Decision

1. **Lint runs through Vite+.** `npm run lint:ox` is `vp lint`. The rule set stays in `.oxlintrc.json` and `vite.config.mjs` imports it (`lint: { ...lintRules, options: { typeAware: true, typeCheck: true } }`), so there is one source of rules and no duplicated configuration. `.oxlintrc.json` no longer carries `$schema`, because oxlint now ships inside `vite-plus` and no longer exists at `node_modules/oxlint`.
2. **The `oxlint` devDependency is removed.** `vp lint` uses its bundled oxlint (`vp --version` reports `oxlint v1.94.0`) even when `node_modules/oxlint` is absent, so a separate install only created a version skew: the repository pinned 1.95.0 while the gate ran 1.94.0. The linter version now follows `vite-plus`, and a toolchain bump is judged by rerunning the gates.
3. **Type check runs through Vite+.** `npm run typecheck` is `vp check --no-fmt --no-lint`, which type-checks with tsrs while skipping format and lint rules. It reads `tsconfig.json`, so `strict`, `noImplicitAny`, `erasableSyntaxOnly` and `verbatimModuleSyntax` still apply, and it covers `tests/` and `scripts/` as the config declares.
4. **One composite gate.** `npm run check` is `vp check` (format, lint, type check). CI replaces the three separate steps with it and keeps the custom checks (`check:test-wiring`, `lint:versions`, `lint:invariants`) as their own steps.
5. **Determinism is a fixed bug with a guard.** `scripts/stable-node-imports.ts` is a rolldown `renderChunk` hook that sorts consecutive `node:` import lines, which removes the ordering the spike saw vary. `scripts/check-dist-determinism.ts` builds repeatedly and compares a content hash; CI now compares three builds instead of two.

## Evidence

Recorded on 2026-11-27, Node 26.13.1, `vite-plus 1.8.0` (`oxlint v1.94.0`, `tsrs v7.1.0-beta.tsrs4`), at commit `30c3849` plus this change.

- `vp lint --print-config` reflects the `lint` section of `vite.config.mjs`, and reports the same clean result as `oxlint` did with `.oxlintrc.json`: 0 findings.
- Moving `node_modules/oxlint` aside left `vp lint` working, which shows the bundled binary is used rather than a local install.
- Type-check equivalence, probe file with an implicit `any` parameter and a null dereference:
  - `vp check --no-fmt --no-lint` reported `TS7006` and `TS18047` for the file;
  - `tsc -p tsconfig.json` reported the same two diagnostics;
  - a probe under `tests/` and one under `scripts/` were reported by both.
  - `vp check` exits 1 when a type error is present.
- `node scripts/check-dist-determinism.ts 20` printed `dist is identical across 20 builds (a7b665486f98)`.

## Consequences

- Linter, formatter, type checker, test runner and bundler versions all move with `vite-plus`. A `vite-plus` upgrade is a toolchain change: rerun `npm run check` and `npm test` and review new lint or type findings, do not treat it as a routine dependency bump.
- tsrs is a beta native checker. `typescript` stays installed for editors and as the reference implementation; when a `tsrs` diagnostic is disputed, run `npx tsc -p tsconfig.json` and compare.
- `.oxlintrc.json` keeps its role as the rule source but is no longer self-describing for editors. Rules are added there, not in `vite.config.mjs`.

## Non-goals

- No `vp check --fix` or `--fix-dangerously` in CI.
- No Vite+ global install or version manager; the repository uses the local devDependency only.
