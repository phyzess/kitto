# Comment policy

Write intent in names, tests and code. Put durable engineering decisions in ADRs and proposed work in local issue drafts. Preserve existing semantic and compliance directives. Use `/delete-comment` from the Kitto checkout to audit or remove old comments; issue publication is a separate decision.

## Reproduce

Use the development Node version from `.node-version`, Python 3 and Bash. Install with `npm ci --ignore-scripts` on glibc Linux or macOS (x64 or arm64). The checker resolves the locked native platform package directly; a global `ast-grep` or its npm postinstall is not used.

```sh
npm ci --ignore-scripts
npm run lint:comments -- --base <trusted-target-commit-sha>
node scripts/check-comments.mjs --inventory <commit-sha>
node scripts/check-comments.mjs --inventory worktree
```

Use the current target branch’s full commit SHA, not an older baseline or a revision chosen from the change. Local lint checks the index and the worktree independently against that commit. The worktree includes Git-visible untracked files; ignored local files and untracked `.agent-teams/` harness state are out of scope. Tracked harness state, unsupported formats and nonregular entries fail. `--head <sha>` compares immutable commits instead; `--pr-head <sha>` requires the head object’s two parents to be the specified base and PR tip in that order.

GitHub Actions compares the checked-out PR merge SHA against the event’s target SHA and a push to `main` against its event predecessor. Outside the one-time exception, CI extracts the checker, its imports, the package manifest and lockfile only from the base commit; the checker reads candidate blobs without executing them. Missing, zero, or mismatched revisions do not fall back to `HEAD` or the historical audit base. A PR can still propose edits to the workflow wiring itself: use a trusted protected ruleset or require separate maintainer review of gate changes. This repository change does not configure those settings.

### First rollout: independent approval required

The reviewed target `5368e35ddee521a389e9c676b4edb3929937c8fc` contains no checker. Only `phyzess/kitto` PR [#50](https://github.com/phyzess/kitto/pull/50), from `kitto/comment-ratchet` to `main` in the same repository at that exact target, gets a warning instead of running a trusted ratchet. The step verifies the checked-out merge SHA and its two ordered commit parents against the event base and PR tip. If the target advances before adoption and still lacks the checker, stop and review the new base and its delta; the current exception does not apply.

Before merging the rollout, a maintainer who did not author it must independently review the exact candidate under the protected approval process. Review the workflow, checker and imports, manifest and lockfile, and both the [original](comment-audit.md) and [incremental](comment-audit-main-sync.md) audit records. Use a clean checkout of the reviewed PR merge commit and the actual event PR tip to reproduce the diagnostic:

```sh
npm ci --ignore-scripts
node --test tests/comment-ratchet.test.mjs
npm run lint:comments -- --base 5368e35ddee521a389e9c676b4edb3929937c8fc \
  --head "$(git rev-parse HEAD)" --pr-head "$REVIEWED_PR_TIP"
```

Record the target, merge commit, PR tip, reviewed tree ID, check results, and approval. Changed candidate bytes require renewed approval. The workflow warning and candidate-side checks are diagnostic; neither grants approval nor establishes trusted ratchet evidence.

The first push to `main` with that exact predecessor fails the ratchet step deliberately: the predecessor has no trusted checker, and a merge or squash does not make the pushed checker an independent verifier of itself. Re-running the push check will not change its predecessor. The maintainer verifies that the landed tree matches the approved tree before relying on its checker for future changes; any discrepancy requires review. The next push or PR whose base includes the reviewed checker uses that base's bytes normally. There is no first-push bypass.

## Scope and comparison

JavaScript, TypeScript, Python, Bash and YAML use syntax nodes. JSON (including the extensionless Pi flag) and `.node-version` are validated comment-free formats. `.gitignore` recognizes `#` only in column one; `\#` and hashes in patterns are data. Env has a single-line assignment grammar: unquoted `#` starts a comment at a shell word boundary, not inside a value, and quoted hashes are data. Use a plain or quoted value; multiline assignments and shell commands are outside the env template grammar.

The workflow YAML scanner maps static `run` steps to Bash, then maps single-quoted Node module and Python heredocs where supported. Here-documents passed to plain `cat` are data. Other workflow sinks, shells, ambiguous embeddings and expressions in executable `run` text require explicit scanner support; pass expressions as environment values. Markdown (including HTML sentinels and fenced samples), license text, and JavaScript strings and test fixtures are not scanned as further code. The vendored skill trees and self-managed `config/pi/extensions/herdr-agent-state.ts` are protected by exact paths, modes, and blob IDs.

JS and stripped TypeScript run syntax-only Node checks, Python uses `ast.parse`, and Bash uses `bash -n`. TypeScript, YAML, and mapped executable fragments also inspect the full tree for explicit `ERROR` and `MISSING` recovery nodes. Full-tree inspection is bounded to 96 KiB per source or fragment; larger input fails closed. These are syntax checks, not a TypeScript type check, YAML schema validator, or GitHub Actions validator. The checker never executes scanned source.

Ordinary TypeScript, YAML and mapped executable edits remain in scope when these guards accept them. YAML also uses the pinned `yaml@2.9.1` parser in strict document mode before indexing: invalid escapes, unresolved aliases, and duplicate keys fail. YAML token separation must use spaces; tabs inside quoted values and block payloads remain data. Application tags outside workflow YAML are treated as inert syntax, without evaluating tags or expanding aliases into runtime data. Unsupported workflow structures and parser failures are rejected.

Per path, language and executable fragment, each exact comment may occur no more often than at the trusted base. Deleting other comments cannot compensate for an addition or edit. A line-number shift from code edits does not by itself change identity; relocation across paths or fragments, including renames, is a new occurrence. A previously removed comment cannot be reintroduced once the target stops carrying it. Existing recognized directives must stay while their file exists. The checker also binds a directive to its position among non-comment lines and, for line or region directives, to the adjacent source it affects; moving the same text to a different target is a violation. New first-line `#!/usr/bin/env node`, `python3`, or `bash` shebangs are exempt only in matching source files; new lint/type suppressions are not exempt.

## Audit and measurement

Inventory JSON contains the snapshot and file blob IDs, source paths, parser languages, nested fragment identities, exact raw token text and SHA-256, and the one-based occurrence among identical tokens in a fragment. `byteStart`/`byteEnd` are zero-based half-open byte offsets in the original file. `start`/`end` give one-based physical lines and Unicode code-point columns. `text` is the parser’s token text; `raw` preserves original indentation across a mapped multiline token. The initial workflow’s heredoc comments remain in the immutable bootstrap inventory and were not copied into `scripts/ci-install-native.mjs`.

`commentOnlyLines` is the union of physical LF-delimited lines touched by at least one token with only whitespace outside the token spans. `ordinaryCommentOnlyLines` leaves out lines with semantic directives. Inline comments with code to either side contribute zero; a multiline block may contribute interior lines, and two tokens on the same line count once.

For a cleanup, intersect the baseline’s `commentOnlyLines` per file with old physical lines actually deleted in `git diff --no-renames --unified=0 <SHA>`. Confirm in each hunk that a counted line disappeared rather than being edited in place or replaced with a blank line. Skip unrelated blank-line deletion. Report the summed physical comment lines removed separately from the net physical line delta over the chosen scope (including any new ADRs or drafts). In the disposition ledger, cite snapshot/path/language/fragment/hash/occurrence per token and link each migration to its ADR or draft.
