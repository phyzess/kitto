# ADR 004: Use host-owned lifecycle, preserving native trust and side-effect boundaries

Status: accepted (records existing behavior).

## Context

Native CLIs often initialize local state even during diagnostic calls. DSH Desktop and Web have different owners, and host extensions need to follow the lifecycle and trust models of their runtimes. Third-party metadata must not become a Kitto-owned maintenance burden.

## Decision

- **Version policy.** `kitto hosts` explicitly checks or installs selected CLI pins, never chases a dist-tag, warns on unvalidated overrides in preview and apply, and verifies the exact installed string. Numeric version triplets alone are insufficient for prerelease baselines. Kitto's self-update notice is bounded to its own package, nonblocking and best-effort; Pi still owns its other packages. pnpm is pinned for DSH native plugin tooling. CI leaves host package scripts off except the narrow pnpm rebuild described in the [pnpm draft](../issue-drafts/remove-ci-pnpm-placeholder-workaround.md).
- **Host probes.** Run even Codex version/help checks with a scratch home. DSH Desktop is app-managed and case-insensitively reserved: do not install/upgrade its CLI, require pnpm, modify the native patch or install/remove a Kitto bundle there. Its diagnostic probe needs a manifest first and reads from a scratch home (copy manifest and optional compatibility metadata) so profile locks cannot touch the actual profile. Keep unavailable, unreadable, timeout and absence distinct. DSH's adapter loads compatible modules from the selected native install; preview may defer when that CLI has not been installed.
- **Activation and trust.** The Web archive-review plugin anchors itself to the launcher's `profileContext` service, not environment projected into tool calls. Read the durable archive registry rather than caching event notifications or appending to conversations from an event; reload and unarchive must reflect reality. A DSH skill catalog entry advertises Kitto and loads its body on demand. Keep Codex hook review/trust intact outside a fixture that owns its entire short-lived configuration. The Linux Pi `herdr-agent-state.ts` entry is self-managed and skipped by sync; leave its file and metadata byte-for-byte upstream.
- **System service boundary.** A service runs setup under its account from a readable, root-owned staging directory containing only necessary executable assets. Create account-owned shared files under the identity that will use them, and handle parent existence changing during inspection. Preserve the read-only/apply distinction for probes and setup.

## Consequences

Host updates may require adjusting integration assumptions, but a preview should never be the first writer of a user's host state. Native tests use pinned hosts without sign-in or model calls and fixture CLIs never talk to the network. DSH AgentTeams' [reference fragment](../../config/dsh/agent-teams.profiles.yml) is manual, not a deployment: configure the subscription routes first (Grok through opencode-go), merge the `agent-teams` entry by ID into the Web profile without dropping `stateDir`/`memberProvider`, and start a new session after restarting Web. Tool policies shape available tools, not an OS sandbox. Verify templates with `/agent-teams --profile dev-standard <goal>` (or the corresponding create call with `approval: "required"`); retain model independence when possible and report same-model fallback honestly. A third opinion is a separate role, added on demand.
