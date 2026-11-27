# ADR 008: One ownership ledger in `state.json`

Status: proposed. Phase A ships the module, the migration and tests; nothing calls them yet and no real state is migrated. Phase B wires callers and activates the migration.

## Context

Kitto may only modify or delete what it created. Today that knowledge is spread over five mechanisms with different shapes and lifecycles:

| Mechanism | Location | Shape |
| --- | --- | --- |
| Shared skills | `state.skills` | `{ name: treeHash }` |
| Host skills | `state.hostSkills[group]` | `{ name: treeHash }` |
| Kept skills | `state.keptSkills[group]` | `[name]`, user content deliberately left in place |
| Keep policy | `state.keepExistingSkills` | boolean flag set by `environment-setup` and service setup |
| Instructions | `state.instructions[host]` | the managed `AGENTS.md` block text |
| Codex MCP | `state.mcp.codex`, `state.mcp.codexPending` | `{ name: fingerprint }`; pending is provisional and can coexist with a confirmed hash during an update |
| DSH MCP | none | rows are recognized by the `kitto-mcp-` prefix inside DSH patch files; no state is recorded |
| Pi packages | `config/pi/local/managed-packages.json` in the configuration checkout | JSON array of package specs, written by `pi_config.py record-settings` and read by the settings merge |

Consequences: three vocabularies for "pending", "kept" and "owned"; Pi ownership lives outside `state.json` so it is invisible to recovery and removal; each new host adds another ad hoc field.

## Decision

Record every Kitto-owned resource in one map:

```
state.schema = 2
state.owned[kind][scope][name] = { hash, status, previous?, spec? }
```

- `kind`: `skill`, `instructions`, `mcp`, `pi-package`.
- `scope`: the group or host: `shared`, `pi`, `codex`, `dsh`.
- `status`: `owned`; `pending` (provisional, an operation was started and may have been interrupted); `kept` (pre-existing user content left in place, `hash` is `null`).
- `previous`: the confirmed hash while an update is pending. Forgetting the pending entry reverts to it.
- `spec`: the original Pi package entry, kept only for `pi-package`.
- Instructions use the fixed name `agents-md`; its `hash` is the managed block text itself, because the planner compares the live block with it verbatim.
- `state.keepExistingSkills` stays a top-level policy flag. It records intent, not ownership.
- `lib/ownership.mjs` holds pure functions over a state object: `get`, `list`, `scopes`, `record`, `markPending`, `promote`, `forgetPending`, `markKept`, `release`, `replaceScope`, `recordedHash`, `isOwnedWith`. Reads never create state; invalid kinds, scopes, names (including `__proto__`) and empty hashes throw.
- `lib/state-schema.mjs` holds `CURRENT_SCHEMA = 2`, `migrateState`, `downgradeState`, `loadState`, `saveState`, `rollbackState`.

An entry that is both owned and kept in v1 (not produced by current code) becomes owned.

## Mapping from current operations

| Today | Ledger call |
| --- | --- |
| `skillPlan` reads `owned = state.skills` or `state.hostSkills[g]` | `list(state, 'skill', g, 'owned')` as a `{name: hash}` view; membership via `get` |
| `skillPlan` `Object.hasOwn(owned, name)` (keepUnowned) | `get(...)?.status === 'owned'` |
| `skillPlan` `kept.includes(name)` / loop over `kept` | `list(state, 'skill', g, 'kept')` |
| `deploy` rebuilds `owned` and `kept`, assigns `state.skills`, `state.hostSkills[g]`, `state.keptSkills[g]` | `replaceScope(state, 'skill', g, { owned, kept })` |
| `existingSkillAction(..., owned[name], ...)` | `recordedHash(state, 'skill', g, name)` |
| `setup` `keepExistingSkills = true` | unchanged top-level flag |
| `instructionPlan` `previous = state.instructions?.[name]` | `get(state, 'instructions', host, 'agents-md')?.hash` |
| `applyInstructions` sets or deletes `state.instructions[name]` | `record(...)` or `release(...)` |
| Codex `owned`/`pending` maps in `collectPlan`, `liveDetails`, `buildMcpPlan` | `list(state, 'mcp', 'codex', 'owned')` and `list(..., 'pending')` |
| `savePending` | `markPending` |
| `promotePending` (also used by `adopt`) | `promote(state, 'mcp', 'codex', name, hash)` |
| `forgetPending` | `forgetPending` |
| `forget` / `remove` delete confirmed and pending | `release` |
| `recorded = codex[name] ?? codexPending[name]` | `recordedHash` |
| `verifyLive` fingerprint check | `isOwnedWith(..., { includePending })` |
| End-of-apply stale pending sweep | `forgetPending` per stale entry |
| DSH `kitto-mcp-` rows | not recorded in this phase; the prefix stays the identity. Phase B may record `mcp/dsh/<row>` with the row fingerprint so removal can verify before deleting |
| Pi `record-settings` writes `managed-packages.json` | `record(state, 'pi-package', 'pi', packageKey, sha256(spec))` plus `spec` |
| Pi `previous` list in the settings merge | `list(state, 'pi-package', 'pi')` mapped to `spec` |

## Migration and rollback

`migrateState(v1, { piLocalDir })` is pure and idempotent: it clones the input, moves every record into `state.owned`, deletes `skills`, `hostSkills`, `keptSkills`, `instructions`, `mcp.codex`, `mcp.codexPending` (and `mcp` when empty), sets `schema: 2` and writes `state.migration = { from: 1, present, pi: { imported } }`. `present` names which v1 containers existed, including empty ones, so that rollback is exact. A missing `schema` is read as 1. Any other schema than 1 or 2 is refused with an upgrade message and nothing is written. When `piLocalDir` holds `managed-packages.json` its entries are imported and its path is returned in `removable`; the file is never deleted by the migration.

`loadState(path, { dryRun, piLocalDir })` reads and migrates. On the first real migration it writes `state.v1.json` next to `state.json` with the original bytes (exclusive create, never overwritten, so the first v1 snapshot survives later rollbacks and re-migrations) and then replaces `state.json` atomically (temporary file and rename, as `atomicJson` in `lib/kitto.mjs`). With `dryRun` it migrates in memory only. `saveState` refuses non-v2 state.

Rollback: `rollbackState(path)` applies `downgradeState`, the exact inverse for every v1 state Kitto writes. Pending skills, non-Codex MCP scopes and kept MCP entries have no v1 form and make the downgrade fail loudly instead of dropping ownership; `pi-package` entries are dropped because the external file is still present until Phase B removes it. The fallback is copying `state.v1.json` over `state.json`, which loses changes made since migration.

## Phase B checklist

1. Switch `configurationPlan`, `deploy`, `skillPlan` and `existingSkillAction` in `lib/kitto.mjs`, or their successors in `lib/hosts/*`, to `list`, `get` and `replaceScope`.
2. Switch `instructionPlan` and `applyInstructions` in `lib/host-config.mjs`.
3. Switch `collectPlan`, `savePending`, `promotePending`, `forgetPending`, `applyCodexMcp`, `removeCodexMcp` and `liveDetails` in `lib/codex-mcp.mjs`; keep the pending semantics of `previous`.
4. Activate the migration at one point: where setup and update load `state.json` (`json(statePath)` in `lib/kitto.mjs` and `kittoHome()` consumers), replacing it with `loadState` and passing `piLocalDir` for the configuration checkout. Setup writes `schema: 2` instead of `schema: 1`. Check every reader of `state.schema === 1`, including `lib/routing-policy.mjs`.
5. Port `record-settings` and the `previous` read in `lib/pi_config.py` (or its JS replacement) to the ledger, then delete `managed-packages.json` from the paths in `removable` after a verified setup.
6. `kitto setup --recover` reads the saved state: it must call `loadState`, and an older Kitto that meets schema 2 must stop with the unsupported-schema message instead of overwriting the ledger. Recovery must treat `pending` entries as unfinished work, as the Codex sweep does now.
7. Decide whether DSH rows get ledger entries (see mapping), and add `saveState` to the `save` callbacks that now call `atomicJson`.
8. Release note and a versioned deprecation of `downgradeState` once a release has shipped.

## Consequences

One vocabulary for ownership and one place for recovery and removal to look. The cost is a one-way schema bump: older Kitto versions refuse schema 2, so rollback needs `rollbackState` or `state.v1.json` before downgrading the package.
