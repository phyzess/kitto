# ADR 007: Threat model for defensive code

Status: proposed.

## Context

Kitto deploys rules, skills and MCP configuration to Pi, Codex and DeepSeek Harness. Its history shows many defensive branches added after a single incident, without a written statement of what they defend against. That makes it hard to decide whether a new guard is needed, or whether an old one can be removed. [ADR 001](001-configuration-and-host-boundaries.md) to [ADR 006](006-main-sync-decisions.md) each record guards for a specific failure; this ADR states the common boundary.

## Decision

Kitto's user is one owner running Kitto on machines that owner controls. It defends against accidents and mistakes, not against an adversary.

**In scope.**

- **Loss of user-owned configuration.** Setup and sync must not overwrite or delete host configuration the user wrote. Source-governed keys are managed; machine runtime keys and local overrides survive ([ADR 001](001-configuration-and-host-boundaries.md)). Preview must show what apply will do.
- **Credential leakage into synced repositories.** MCP definitions that contain tokens, userinfo URLs or secret-like headers are detected and kept out of the synced source ([ADR 002](002-mcp-portability-and-ownership.md)).
- **Host state corruption.** A failed or partial deployment must not leave a host unusable. Preserve the previous verified runtime until the new one is deployed, parse host config structurally, and edit it minimally ([ADR 003](003-runtime-and-worktree-safety.md), [ADR 004](004-native-integration-policy.md)).
- **Concurrent Kitto runs.** Two runs, or a run and an interrupted run, must not interleave writes. Use write locks with recorded ownership and distinguish live, dead and unverifiable owners ([ADR 006](006-main-sync-decisions.md)).
- **Worktree and runtime mistakes by the owner or their agents.** Destructive worktree operations require explicit confirmation and ownership checks ([ADR 003](003-runtime-and-worktree-safety.md)).
- **Environmental variance.** Symlinked temporary directories, slow version-manager shims and eventually consistent registries are normal conditions, handled as bounded waits and identity comparisons.

**Out of scope.**

- Malicious local users on the same machine. The documented system-service setup in [ADR 004](004-native-integration-policy.md) keeps its own root-owned staging boundary; Kitto does not otherwise defend against other accounts.
- Hostile or tampered host binaries, npm packages, or a compromised registry beyond the pinned versions and integrity checks already recorded.
- Adversarial repository contents beyond credential scanning. Kitto does not sandbox, review or rate the safety of skills, rules or MCP servers the owner chooses to install.
- Compromise of the owner's account, shell, or git remotes.
- Denial of service against Kitto itself, and races against an actor that writes into Kitto-owned directories deliberately.
- Guarantees about host behavior that the host does not document; Kitto records observed behavior with evidence and a host version.

**Rule for new code.** Each new defensive branch, validation or lock must name the in-scope threat it addresses, in the PR description or the nearest ADR. A guard that maps only to an out-of-scope threat is not added; an existing one that does is a candidate for removal through its own PR. Extending the scope requires amending this ADR.

## Consequences

Reviewers can reject speculative hardening and ask for the threat name. Maintainers can delete guards that exist only for out-of-scope threats. Users must not treat Kitto as a security boundary against untrusted content or other local users. This ADR is proposed; accept it, or amend the lists, before relying on it to remove existing code.
