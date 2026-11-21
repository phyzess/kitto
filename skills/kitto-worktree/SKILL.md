---
name: kitto-worktree
description: Inventory Git worktrees by estimated size and report blockers without changing any tree. Use when asked where worktree disk space goes or whether worktrees have outstanding work.
---

Run `kitto worktree audit --json` in the requested repository. Only for an explicitly named workspace, pass `--workspace PATH` as well. If the CLI is unavailable, report that; do not install or deploy anything.

Report the largest trees, their estimated sizes, and the evidence for blockers. Preserve unknowns: local ancestry does not prove remote delivery, and clean Git status does not establish ownership, inactivity or permission to remove. This workflow is inventory only. Do not remove, prune, unlock, move, adopt or modify trees or branches.
