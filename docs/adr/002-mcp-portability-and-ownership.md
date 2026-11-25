# ADR 002: Translate only portable MCP declarations and manage only owned state

Status: accepted (records existing behavior).

## Context

Pi, Codex, and DSH represent MCP transports and secrets differently. Blind translation could expose credentials, widen tool access or take over a personal server. Native operations are not all atomic or read-only, even when invoked as queries.

## Decision

1. **Portable source and reference only.** Read Pi base then the platform overlay. Only an explicit global opt-in includes machine-local then private overlays; that ordering matches Pi's own merge. A whole `${VAR}` may map to a runtime credential reference, with `Bearer ${VAR}` allowed for Authorization. DSH uses `${credential:VAR}` templates and per-row `expandTemplates`. Codex exposes only `--bearer-token-env-var` for this HTTP case; do not imitate reference semantics by passing a literal with `--env`. Refuse an entire entry rather than discard an unrepresentable auth, timing or tool-exposure setting. Credential-shaped headers, flags, URL components and unresolved placeholders also block translation. Use paths and labels in diagnostics, not matched values or command argv. Keep literal-shape rules aligned with Python export guards.
2. **Codex reconciliation.** Preview receives live inventory from a scratch `CODEX_HOME` seeded with `config.toml`, because even reads may create helper files. A missing home implies no inventory and requires no probe. Compare the intended transport fingerprint with the live normalized transport and preserve externally adjusted settings. Persist provisional ownership before a native add, promote it only when the matching transport is observed, and clear orphan/stale pending and owned records. A URL add can write config before discovery fails; recheck for an exact transport and preserve the original native failure if that check also fails. A name alone is not ownership. Native apply needs its own skip diagnostic if there was no separate preview display.
3. **DSH surgical patches.** Preserve the home and per-profile patch layering and recognize externally declared server names. Replace only whole owned insert items (all rows use the Kitto MCP namespace); preserve unrelated text, including comments, a dash split from its mapping, and trailing document markers. Treat an empty document or null as no rows. Keep `!!js` scalar expressions inert while parsing; do not interpret their content as executable code. Revalidate before writing. Desktop remains global-only and receives no MCP rows from Kitto.

## Consequences

An honestly incomplete sync is safer than an apparently successful lossy conversion. Expanding the supported subset requires an explicit mapping and tests with dummy credential references. Extending ownership or relaxing fingerprints requires interrupted-operation and user-edit scenarios in the [Codex suite](../../tests/codex-mcp.test.mjs) or equivalent [DSH sync tests](../../tests/mcp-sync.test.mjs).
