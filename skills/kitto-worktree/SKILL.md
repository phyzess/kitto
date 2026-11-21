---
name: kitto-worktree
description: Inventory Git worktrees or preview opening and retiring a Kitto-managed task checkout. Use for worktree disk usage, task checkout creation, reuse, and manual cleanup.
---

Run `kitto worktree audit --json` in the requested repository. Only for an explicitly named workspace, pass `--workspace PATH` as well. If the CLI is unavailable, report that; do not install or deploy anything.

Report the largest trees, sizes, and blockers. Local ancestry does not prove remote delivery; clean Git status does not establish ownership, inactivity, or permission to remove.

For a task checkout, use `kitto worktree start --repo PATH --task ID --session ID` to preview. Show the repo, base commit, proposed path and whether it creates or reuses the checkout. Summarize any `handoffHints` as counts from the local ledger only; no recorded claim does not mean idle, and an incomplete scan is not an all-clear. Offer a separate manual review, not removal. Ask for explicit user approval before adding the exact `--confirm TOKEN`; do not claim this changes the caller's directory. Give every participating session a distinct ID.

When this Kitto task genuinely ends in a live, interactive conversation, and the operator has not already decided or been asked for this completion, include one question in your handoff: “Would you like a read-only cleanup preview for this task's Kitto worktree?” Ask once per task completion, not per turn, reload, resumed conversation, or subtask. If the operator declines, leave the tree alone. Do not run a command merely to ask this question. Do not inject a prompt into an archived conversation or promise a headless prompt.

For an explicit DSH archive review in a different live conversation, use `kitto_worktree_archive_review` if available and the operator provides the primary repo, Kitto task ID, and the native DSH session ID they deliberately registered as its Kitto claim. Report a verified pending review, not inactivity. If unavailable or unbound, keep the manual handoff; do not search for or guess other session IDs.

For manual retirement, require the operator to verify all relevant host sessions, child tasks, processes and mounts are inactive and to supply the full delivered local base commit. Do not infer quiescence from an archive notification, a clean tree, or silence. Exit, reload, fork and SessionEnd are not archive; archive and unarchive are at most reminders to inspect. Do not execute a Kitto command automatically in response to any host event. Use a new manual preview on the next explicit start or handoff. If verified, run `kitto worktree finish --repo PATH --task ID --session ID --quiescent --delivered SHA` from outside the target. Report all blockers. Only with separate explicit user approval, use `kitto worktree apply` with the same arguments and the fresh `--confirm TOKEN`. To release a departing session without removal, use `--release` instead of `--delivered SHA`, with the same preview and approval. Never bypass a blocker, use a host-managed checkout, adopt an existing tree, force Git removal, or delete a branch.
