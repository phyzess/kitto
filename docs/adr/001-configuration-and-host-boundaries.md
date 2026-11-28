# ADR 001: Keep portable configuration separate from host and machine state

Status: accepted (records existing behavior).

## Context

Kitto assembles instructions and configures multiple host applications. The hosts have different discovery, precedence, and installation rules. Treating every observed setting as portable could export local secrets, copy stale shared instructions back into their source, or overwrite host-owned state.

## Decision

- **Entry points and ownership.** The JS CLI owns public setup, synchronization, and shared skill deployment (content ownership plus a lock). `setup.sh` delegates to it; the bundled maintenance runner is an internal endpoint. The Pi adapter is a JavaScript module (`lib/pi-adapter.ts`) that only the JS CLI calls in process; there is no separate shell or Python entry. `setup.sh --force` is a deprecated noninteractive alias: it wins over `--interactive` independent of order, warns once, and detaches stdin if needed so a TTY cannot start the wizard. The empty-array branch is intentional for macOS Bash 3.2 with `set -u`; do not collapse it without checking that version.
- **Instruction composition.** Canonicalize to LF without a BOM. The JS host config and the Pi adapter share one composition function, so they agree byte-for-byte on shared text, the `<!-- kitto:host-addendum -->` boundary, and host text. When exporting, require one boundary and an exact complete match against the *current* shared section before writing other repository files. Prefix matching would mistake deleted trailing shared rules for host text. A configuration source without `config/instructions/common.md` is rejected with a clear error; there is no whole-file fallback.
- **Pi state.** The source governs declared keys and managed packages; machine runtime keys and local overrides survive a pull. Preserve object-form packages without flattening them into the text list. Export shared values in stable source order, but do not serialize credentials, private overlays, machine-only packages, or unmanaged and platform-only MCP servers. Leave `.env`, `config/pi/mcp.private.json`, and `config/pi/local/` out of Git. Deploy `~/.pi-agent-env` only when absent, with private permissions; honor the operator's environment and existing file. Determine dependencies from the deployed Pi MCP config when it exists, so local selections are respected.
- **Scoped hosts.** Load additional instructions and skills without replacing native context. Pi's native skills win name collisions, with the innermost configured scope winning among additions; deduplicate already-loaded instruction paths. DSH preserves native project skill priority (native ranks 100/200; scoped additions 225/525), skips paths in the native instruction chain and matches DSH's 1 MiB per-file limit. Native entry points locate installed scope runtime state even without setup-shell environment variables. The app-managed DSH Desktop profile is never given a Kitto scope adapter; other hosts in mixed setup can still proceed.

## Consequences

Kitto runs only on its owner's machines, so configuration sources must carry the shared layer and there is no deprecation cycle for older layouts. Use the [adapter tests](../../tests/pi-adapter.test.ts) and the [CLI tests](../../tests/kitto-rules-setup.test.ts) to exercise boundary rejection and preview vs. apply. Intentionally ignored and externally managed state should not be handed to new deployment helpers as input to export.
