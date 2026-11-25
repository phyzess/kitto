---
name: delete-comment
description: Audit Kitto comments and prepare deletions, ADRs, or issue drafts.
disable-model-invocation: true
---

# Delete comments

Use this skill only at the Kitto repository root. Treat the user’s requested paths as the scope; without paths, use the inventory’s full first-party scope. Read [the comment policy](../../../docs/comment-policy.md) for exclusions, inventory fields, and counting rules.

1. **Inventory.** Identify the trusted target commit and record its full SHA. Install the locked development tools with `npm ci --ignore-scripts` if missing. Run `node scripts/check-comments.mjs --inventory <SHA>` and the same command with `worktree`. Record the before snapshot and the in-scope token IDs. Check local changes before editing and preserve unrelated edits.
2. **Classify.** Read each token in source context; record one disposition per token: **Delete** (redundant, stale, or dead code), **Keep** (semantic or compliance requirement), **ADR** (decision future maintainers need), or **Issue draft** (a concrete workaround or implementation risk). If evidence is insufficient, leave the token unchanged and mark it unresolved. This step is complete when every in-scope ID has a disposition or an explicit unresolved reason.
3. **Apply.** Delete only verified non-semantic text. For **ADR**, record context, decision, and consequences before deleting and link every migrated ID to its destination. For **Issue draft**, capture the location, observed behavior, risk, proposed approach, reproducible preconditions, and acceptance criteria; link every implicated ID and preserve any fact still required to understand or safely use the code. Keep the draft local: publication needs a separate explicit user confirmation.
4. **Verify and report.** Run `npm run lint:comments -- --base <SHA>`, `git diff --check`, and targeted behavior checks. Recompute removed comment-only physical lines per the policy. Report the base SHA, coverage and unresolved items, disposition counts, ADR/draft links, physical removals versus net line delta, and test results. Claim full completion only if all in-scope IDs are accounted for and verification passes.
