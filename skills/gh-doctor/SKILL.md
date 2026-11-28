---
name: gh-doctor
description: Diagnose gh CLI authentication, Resource not accessible by personal access token errors, gh pr checks or gh project failures, and run GitHub capability preflight across machines or harnesses.
---

# gh-doctor

Read-only diagnostic preflight for `gh` CLI credentials, scopes, and token-type capabilities.

## Steps

1. Run `gh-doctor.ts` with target flags before retrying failed GitHub calls or when entering a new environment:

```sh
~/.agents/bin/kitto-node ~/.agents/skills/gh-doctor/scripts/gh-doctor.ts --json
~/.agents/bin/kitto-node ~/.agents/skills/gh-doctor/scripts/gh-doctor.ts \
  --repo <owner/name> --project-owner <owner> --project-number <n> \
  --require auth,repo,checks,project --json
```

2. Act on `diagnosis`:
   - `ok`: proceed with GitHub CLI operations.
   - `fine_grained_pat_unsupported`, `missing_project_scope`, `unauthenticated`, `invalid_token`, `checks_forbidden`, `repo_forbidden`, `project_forbidden`: stop retrying GitHub calls; report `diagnosis` and the copy-pasteable `remediation` commands for the user to run locally.
   - `network_error`: treat as connectivity or timeout rather than an auth failure.

## Boundaries

- Read-only diagnosis only: keep auth state, `~/.config/gh/hosts.yml`, and write authorization untouched.
- Run `gh-doctor.ts` instead of `gh auth login`, `gh auth refresh`, or `gh auth status --show-token`, and keep token values out of output.
