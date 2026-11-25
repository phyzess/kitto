# Incremental comment audit: Kitto PR #50

This ledger is separate from the [original 472-token audit](comment-audit.md). Its upstream range is `4400a587ef93343ec6c5c52d20b7dc8e8468638c` → `5368e35ddee521a389e9c676b4edb3929937c8fc`; the draft parent is `08268a407ab28995cd07ea209df2b9db28f3bddb`.

The inventories contain 472 and 520 tokens, respectively. Matching `(path, language, fragment, raw SHA-256, occurrence)` gives 456 carried occurrences, 64 upstream additions or edits, and 16 original identities already removed upstream. A changed token is a removed identity plus a new identity; a line shift alone is not a change. Every `U` and `R` row below has the empty fragment `[]`. Row order is inventory path order, then byte offset. All 64 `U` rows are ordinary: 42 ADR, 20 Delete and 2 Issue draft; none are unresolved. The nine unchanged semantic tokens (eight shebangs and the first-party TypeScript `@ts-nocheck`) remain on their targets. All seven pinned third-party blobs and modes remain exact.

## Physical lines

- Of the 64 added/changed tokens, 61 occupied whole comment-only LF lines that disappear. Three inline tokens (`U16`, `U19`, `U53`) remove no LF lines. No blank or replacement line is credited here.
- Against the upstream target across the whole tree, 630 old ordinary comment-only LF lines are touched by deletions. Exclude 24 `sync.sh` lines repurposed as byte-identical help data: 606 comment-only lines disappear outright, 61 of them from the increment. Final inventory: nine tokens, nine comment-only lines and zero ordinary comment-only lines.
- Net physical line delta in the eight files with `U` rows: 4,254 → 4,089 (−165). Whole scanned-source scope (excluding Markdown, licenses and protected files): 15,281 → 15,850 (+569, including CI/checker and tests). The new ADR and local follow-up add 31 Markdown lines together; the ledger is separate from these source totals.

## Recompute

Run in the final checkout with the reviewed parser and lockfile installed. Use `AUDIT_AFTER=<final-commit-sha>` to reproduce against a commit instead of the matching index/worktree. The second check verifies the staged and live trees independently while the merge is uncommitted:

```sh
npm ci --ignore-scripts
npm run lint:comments -- --base 5368e35ddee521a389e9c676b4edb3929937c8fc
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { nativeParser } from './scripts/comment-ratchet.mjs';
import { compare, repository } from './scripts/comment-ratchet/snapshots.mjs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const repo = repository('.', nativeParser());
const original = repo.inventory('4400a587ef93343ec6c5c52d20b7dc8e8468638c');
const base = repo.inventory('5368e35ddee521a389e9c676b4edb3929937c8fc');
const final = repo.inventory(process.env.AUDIT_AFTER || 'worktree');
const ids = inventory => new Map(inventory.files.flatMap(f => f.tokens.map(t =>
  [JSON.stringify([f.path, t.language, t.fragment, t.hash, t.occurrence]), { path: f.path, ...t }])));
const delta = (a, b) => [...a].filter(([id]) => !b.has(id)).map(([, t]) => t);
const oldIds = ids(original), upstreamIds = ids(base);
const added = delta(upstreamIds, oldIds), removed = delta(oldIds, upstreamIds);
assert.equal(oldIds.size - removed.length, 456);
const ledger = readFileSync('docs/comment-audit-main-sync.md', 'utf8');
const row = /^(\| ([UR]\d{2}) \| `([^`]+):(\d+)` \| (\w+) \| `([0-9a-f]{64})` \| (\d+) \| ([^|]+) \|)/gm;
const counts = new Map();
for (const [prefix, occurrences] of [['U', added], ['R', removed]]) {
  const rows = [...ledger.matchAll(row)].filter(m => m[2].startsWith(prefix));
  assert.equal(rows.length, occurrences.length);
  for (const [i, t] of occurrences.entries()) {
    const [, , id, path, line, language, hash, occurrence, disposition] = rows[i];
    assert.deepEqual(t.fragment, []);
    assert.deepEqual([id, path, +line, language, hash, +occurrence],
      [`${prefix}${String(i + 1).padStart(2, '0')}`, t.path, t.start.line, t.language, t.hash, t.occurrence]);
    counts.set(disposition, (counts.get(disposition) ?? 0) + 1);
  }
}
assert.deepEqual([added.length, removed.length, counts.get('ADR'), counts.get('Delete'), counts.get('Issue draft')], [64, 16, 42, 20, 2]);
assert.deepEqual(compare(base, final).violations, []);
assert.equal(final.totals.tokens, 9);
assert.equal(final.totals.ordinaryCommentOnlyLines, 0);
assert.equal(final.files.filter(f => f.exclusion === 'protected third-party').length, 7);
let syntaxLost = 0, removedIncrement = 0, inlineIncrement = 0;
for (const file of base.files.filter(f => f.ordinaryCommentOnlyLines.length)) {
  const revisions = final.snapshot === 'worktree' ? [base.snapshot] : [base.snapshot, final.snapshot];
  const patch = git('diff', '--no-renames', '--no-ext-diff', '--unified=0', ...revisions, '--', file.path);
  const deleted = new Set();
  for (const [, start, count] of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? /gm))
    for (let i = 0; i < Number(count ?? 1); i++) deleted.add(Number(start) + i);
  const commentLines = file.ordinaryCommentOnlyLines.filter(n => deleted.has(n));
  syntaxLost += commentLines.length;
  const incrementLines = new Set();
  for (const t of added.filter(t => t.path === file.path)) {
    const lines = commentLines.filter(n => n >= t.start.line && n <= t.end.line);
    if (lines.length) lines.forEach(n => incrementLines.add(n));
    else inlineIncrement++;
  }
  removedIncrement += incrementLines.size;
}
const helpBytes = git('show', `${base.snapshot}:sync.sh`).split('\n').slice(1, 25).join('\n') + '\n';
assert.equal(Buffer.byteLength(helpBytes), 1485);
if (final.snapshot === 'worktree') {
  for (const flag of ['-h', '--help']) assert.equal(execFileSync('bash', ['sync.sh', 'status', flag], { encoding: 'utf8' }), helpBytes);
}
assert.deepEqual([syntaxLost, removedIncrement, inlineIncrement], [630, 61, 3]);
const scope = new Set(added.map(t => t.path));
const physical = (inventory, include) => inventory.files.filter(include).reduce((n, f) => n + f.physicalLines, 0);
for (const include of [f => scope.has(f.path), f => f.language !== 'Excluded'])
  console.log('Physical lines before and after:', physical(base, include), physical(final, include));
console.log('Original identities removed upstream:', removed.length, 'New identities by disposition:', Object.fromEntries([...counts].filter(([k]) => k !== 'Upstream removed')));
console.log('Physical comment-only lines removed:', syntaxLost - 24, 'of which increment:', removedIncrement, 'Inline increment:', inlineIncrement);
JS
```

## Added or edited upstream

Read each row against its target SHA and hash. Delete rows name the test, code or guide that already communicates the intent, or note why the text added no durable fact. ADR and issue-draft rows point to the disposition's destination.

| ID | Upstream location | Language | Raw SHA-256 | Occ. | Disposition | Rationale or destination |
| --- | --- | --- | --- | ---: | --- | --- |
| U01 | `bin/kitto.mjs:179` | JavaScript | `08471d61c8f34fc11795512c86734f288845b6dcb3f90817315d1da016a845e3` | 1 | ADR | Explicit stale-only break and CLI scope: [ADR 006](adr/006-main-sync-decisions.md). |
| U02 | `bin/kitto.mjs:180` | JavaScript | `28c3ec0b885978775eb51558a4d37e5f9211f1be8b359912306f3f130ef14504` | 1 | ADR | Explicit stale-only break and CLI scope: [ADR 006](adr/006-main-sync-decisions.md). |
| U03 | `bin/kitto.mjs:181` | JavaScript | `add95ab3d5b2408f300107e6b24f4888f6ff47dbd7e79d44df2c7242bbcb842c` | 1 | ADR | Explicit stale-only break and CLI scope: [ADR 006](adr/006-main-sync-decisions.md). |
| U04 | `config/dsh/agent-teams.profiles.yml:7` | Yaml | `2235b4bfef6fe70e4f81e65997c25c7924cfcc9cd0cd0bca3bc08e69bae40e63` | 1 | ADR | Configure routes first, preserve local settings, restart and verify: [ADR 004](adr/004-native-integration-policy.md). |
| U05 | `config/dsh/agent-teams.profiles.yml:8` | Yaml | `3165398e013026063206fd0293c9810127f1a8e463e2a3bf0038e6c707900052` | 1 | ADR | Configure routes first, preserve local settings, restart and verify: [ADR 004](adr/004-native-integration-policy.md). |
| U06 | `config/dsh/agent-teams.profiles.yml:9` | Yaml | `835cd81652115bf039c51864afcac171552054c835e85014f02289be2cfc22b7` | 1 | ADR | Configure routes first, preserve local settings, restart and verify: [ADR 004](adr/004-native-integration-policy.md). |
| U07 | `config/dsh/agent-teams.profiles.yml:11` | Yaml | `8f98093b6e9649f6ddc9b26ea5ae35a48b917c559aa2a21720880e7333fdfe8e` | 1 | Delete | The routing guide already limits batch members and reserves Grok for difficult work. |
| U08 | `config/dsh/agent-teams.profiles.yml:12` | Yaml | `59509aa41b9e20681007e4421fe6a6fc33a891ce4bd6580f3c3e5d5933938ef1` | 1 | ADR | The template protocol and [routing guide](orchestration.md#dsh-侧落地) preserve task-selected effort. See [ADR 004](adr/004-native-integration-policy.md). |
| U09 | `config/dsh/agent-teams.profiles.yml:13` | Yaml | `5aa72f0bc2e9c5cdad7ad3ff28953cfd121067e649ef25e8d2be325bbdad8dc1` | 1 | ADR | Independent review and the boundary of tool policies: [ADR 004](adr/004-native-integration-policy.md). |
| U10 | `config/dsh/agent-teams.profiles.yml:14` | Yaml | `cddf50b708d8e2c164256a4e563a1606694ceda4f7ac6bf375f93eec6db2799e` | 1 | ADR | Independent review and the boundary of tool policies: [ADR 004](adr/004-native-integration-policy.md). |
| U11 | `lib/kitto.mjs:100` | JavaScript | `0bb662f767b126757d4e8f8b69aa4bf678daf7c7820cd83dbb8b54881cc00bcc` | 1 | ADR | Owner records distinguish live activity from stale residue: [ADR 006](adr/006-main-sync-decisions.md). |
| U12 | `lib/kitto.mjs:101` | JavaScript | `957173e25629cdb69aafeb966b2124eed3211472a3ff6ebd1250411846d3f304` | 1 | ADR | Owner records distinguish live activity from stale residue: [ADR 006](adr/006-main-sync-decisions.md). |
| U13 | `lib/kitto.mjs:102` | JavaScript | `fc9e3b0b920a16516396e8eb3adbbd510bbd348278a56a1597cb30d560f06888` | 1 | ADR | Owner records distinguish live activity from stale residue: [ADR 006](adr/006-main-sync-decisions.md). |
| U14 | `lib/kitto.mjs:103` | JavaScript | `b967f9045717dda7e6d972eb7475e3cb7e7882aab02cdf8a30359c599155811a` | 1 | ADR | Owner records distinguish live activity from stale residue: [ADR 006](adr/006-main-sync-decisions.md). |
| U15 | `lib/kitto.mjs:115` | JavaScript | `0834a44ed1b67ecaa24857d1ce1b8ac0e520e45eb09b71388c62317d0ffcecae` | 1 | ADR | A permission error indicates an existing owner: [ADR 006](adr/006-main-sync-decisions.md). |
| U16 | `lib/kitto.mjs:143` | JavaScript | `101e70b497779eeac6880bc7cb75a3186b5f51d506c3a4da14feb673d205e0fe` | 1 | ADR | Signal cleanup must preserve the signal exit status: [ADR 006](adr/006-main-sync-decisions.md). |
| U17 | `lib/kitto.mjs:174` | JavaScript | `0b0d23403343f63cb6f55cc2fce918116a5df3b1c5b84ef855b2aaaf88087c65` | 1 | ADR | Pi uses an independent lock and may encounter ownerless legacy state: [ADR 006](adr/006-main-sync-decisions.md). |
| U18 | `lib/kitto.mjs:175` | JavaScript | `4f89e4dba67c1b0fa9e2770f084f53b8e1fbb9192b95a1d0459dee6bf5338555` | 1 | ADR | Pi uses an independent lock and may encounter ownerless legacy state: [ADR 006](adr/006-main-sync-decisions.md). |
| U19 | `lib/kitto.mjs:180` | JavaScript | `9893c18ed353cfeb32bc46247690f89abbbdb28c1a36f3c5d4fa76d0c99dc6af` | 1 | ADR | Pi uses an independent lock and may encounter ownerless legacy state: [ADR 006](adr/006-main-sync-decisions.md). |
| U20 | `lib/kitto.mjs:250` | JavaScript | `7fa8a21aebd7ee5d9768bc8225248e6113cf31c7210330af0c66ecdd0ed5ac66` | 1 | ADR | Host capability checks, missing binaries and optional strict baseline: [ADR 004](adr/004-native-integration-policy.md). |
| U21 | `lib/kitto.mjs:251` | JavaScript | `a8705908a1c90e109a1ad988958f0d2e3f4b343dc92ce35a82e3b5804fbfa0ab` | 1 | ADR | Host capability checks, missing binaries and optional strict baseline: [ADR 004](adr/004-native-integration-policy.md). |
| U22 | `lib/kitto.mjs:252` | JavaScript | `3874c82a40847712d78c5ea0ed5af26dcc517709a968e83d54322e0859c5e435` | 1 | ADR | Host capability checks, missing binaries and optional strict baseline: [ADR 004](adr/004-native-integration-policy.md). |
| U23 | `lib/kitto.mjs:282` | JavaScript | `537aff62efb18d26daa6dab025d0e0afbde7ca4f556835d0f36328ac6063e2c5` | 1 | ADR | Host capability checks, missing binaries and optional strict baseline: [ADR 004](adr/004-native-integration-policy.md). |
| U24 | `lib/kitto.mjs:283` | JavaScript | `4fa87b54fa1a8c6d863462527c809258d36211daeba52f951574bb047c7b1659` | 1 | ADR | Host capability checks, missing binaries and optional strict baseline: [ADR 004](adr/004-native-integration-policy.md). |
| U25 | `lib/kitto.mjs:284` | JavaScript | `8c251f64dae6f828186dcb6a2c2fff1bfcd3c4b1b2ed0faa44a1759d141db5e9` | 1 | ADR | Host capability checks, missing binaries and optional strict baseline: [ADR 004](adr/004-native-integration-policy.md). |
| U26 | `lib/kitto.mjs:327` | JavaScript | `9209782c8a02be9a77c4815581dbc7bd09b0a6e13c76a5266035fa134c3f9a54` | 1 | ADR | Fresh install must resolve to the exact selected pin: [ADR 004](adr/004-native-integration-policy.md). |
| U27 | `lib/kitto.mjs:328` | JavaScript | `f75e465f4a818bb5c8fa1ddea3e1685c834225bf300ac86fd8b7b914c6e26256` | 1 | ADR | Fresh install must resolve to the exact selected pin: [ADR 004](adr/004-native-integration-policy.md). |
| U28 | `lib/kitto.mjs:468` | JavaScript | `edcdcab51d8f380c7466c9791f0c752441fef4a9bac2c77a733d2cf6ab171018` | 1 | ADR | Missing or old Python fails; a slow shim warns: [ADR 006](adr/006-main-sync-decisions.md). |
| U29 | `lib/kitto.mjs:469` | JavaScript | `8df56a1ad9ae698cf71e993fcdb82ba4374425831d4491a7d3ceddf46914d0a7` | 1 | ADR | Missing or old Python fails; a slow shim warns: [ADR 006](adr/006-main-sync-decisions.md). |
| U30 | `lib/kitto.mjs:470` | JavaScript | `71e091a1b8d8167b365689a959058cc9d6af9d8a65b3c480b080df13b4d198f7` | 1 | ADR | Missing or old Python fails; a slow shim warns: [ADR 006](adr/006-main-sync-decisions.md). |
| U31 | `lib/kitto.mjs:471` | JavaScript | `79e249290cfd27d683eb158b82ead8c9ea40032b231a51719877abbecfd3e51e` | 1 | ADR | Missing or old Python fails; a slow shim warns: [ADR 006](adr/006-main-sync-decisions.md). |
| U32 | `lib/kitto.mjs:472` | JavaScript | `98e2d989322d636c396edbf7e4079d4d0e9845381a3aac89f01bf12043b19889` | 1 | ADR | Missing or old Python fails; a slow shim warns: [ADR 006](adr/006-main-sync-decisions.md). |
| U33 | `lib/kitto.mjs:916` | JavaScript | `00d8fc8bff03bc637309dbcb57a50c04e7642e70bdc3643dd1ec32b933891a4e` | 1 | ADR | An unverified runtime needs an explicit next action: [ADR 006](adr/006-main-sync-decisions.md). |
| U34 | `lib/kitto.mjs:917` | JavaScript | `6c049e66a4706876693c345a5bbba33bf6affa63b48780488c879ed390779877` | 1 | ADR | An unverified runtime needs an explicit next action: [ADR 006](adr/006-main-sync-decisions.md). |
| U35 | `lib/kitto.mjs:1032` | JavaScript | `5e43ccf5d9d8163104eb994f5daae0934d481fb6ecbb6867a71f7917b0fd51bb` | 1 | Delete | Duplicates the host policy above and [ADR 004](adr/004-native-integration-policy.md); the setup call passes the flag explicitly. |
| U36 | `lib/kitto.mjs:1033` | JavaScript | `0d748d602896b629099583bd80c469c5002b7402590d00e2482c9421b64a1683` | 1 | Delete | Duplicates the host policy above and [ADR 004](adr/004-native-integration-policy.md); the setup call passes the flag explicitly. |
| U37 | `scripts/release.mjs:12` | JavaScript | `64c38793966e54d41949a80452ddec921094a5df3a19f3698c603271e44a2e27` | 1 | ADR | Registry visibility lags publish acknowledgement; bound retries: [ADR 006](adr/006-main-sync-decisions.md). |
| U38 | `scripts/release.mjs:13` | JavaScript | `b892e771ec4ef145cc0e14f5bf8352916d300c56521c00900f158cb17c392dd9` | 1 | ADR | Registry visibility lags publish acknowledgement; bound retries: [ADR 006](adr/006-main-sync-decisions.md). |
| U39 | `scripts/release.mjs:14` | JavaScript | `b1c01ac4234f9c957a32836563a57605c11bd380acd3199b8b5b015e18f61beb` | 1 | ADR | Registry visibility lags publish acknowledgement; bound retries: [ADR 006](adr/006-main-sync-decisions.md). |
| U40 | `scripts/release.mjs:22` | JavaScript | `815bd453187a54b05ac8a4e8e49a69eacf528b5b82bb7b0e1ece34b4c0acdd79` | 1 | Delete | The polling implementation returns the attempt; its test asserts the value. |
| U41 | `scripts/release.mjs:153` | JavaScript | `c5d8e82ff6c49ebb43ed2f67f815da84240b99c000d6a3d8ac2667e3f927968a` | 1 | ADR | Test the polling path without invoking publish: [ADR 006](adr/006-main-sync-decisions.md). |
| U42 | `sync.sh:83` | Bash | `16b7ba860d2e030bcd177f9879b1b5f417ddfd35a23b6c4f3cfdf85de4e6c671` | 1 | ADR | Handle catchable signals explicitly; SIGKILL cannot be caught: [ADR 006](adr/006-main-sync-decisions.md). |
| U43 | `sync.sh:84` | Bash | `b58c5571d0e00df9ad1ba765e3683e90799a5f7d5609ef739db25ce5ecdd79b6` | 1 | ADR | Handle catchable signals explicitly; SIGKILL cannot be caught: [ADR 006](adr/006-main-sync-decisions.md). |
| U44 | `sync.sh:90` | Bash | `73348e431cbac44dd7aaf07568933f0522ae635cf2d11ad679fa908427fd6864` | 1 | Issue draft | The shell diagnostic can mistake EPERM for a dead owner: [lock follow-up](issue-drafts/main-sync-follow-ups.md). |
| U45 | `sync.sh:91` | Bash | `9d0cf7ab9c21e822d6a681acfb747723a3b93527c602dc838ee773937d5fc7a5` | 1 | Issue draft | The shell diagnostic can mistake EPERM for a dead owner: [lock follow-up](issue-drafts/main-sync-follow-ups.md). |
| U46 | `tests/helpers/fake-agent.cjs:5` | JavaScript | `ba69df58241b3f269b7c2f751895ce38c4e0366821ebd627cf3d68098cd442aa` | 1 | Delete | Flag names and [host setup cases](../tests/kitto.test.mjs) identify the version and capability fixtures. |
| U47 | `tests/helpers/fake-agent.cjs:6` | JavaScript | `f19e94e4a9b9803cf6850e4287b060d29748d29ca9f806dc0188e2ce0a8d15be` | 1 | Delete | Flag names and [host setup cases](../tests/kitto.test.mjs) identify the version and capability fixtures. |
| U48 | `tests/helpers/fake-agent.cjs:7` | JavaScript | `5a66541242716ef2e41ac4cde6adce4eb4097db5c60d8077bc89a40865af8ed0` | 1 | Delete | Flag names and [host setup cases](../tests/kitto.test.mjs) identify the version and capability fixtures. |
| U49 | `tests/helpers/slow-python.cjs:1` | JavaScript | `7a5dab1c433b7d582b28520d7bb862cbf40928068f9d9201ee206c566d76e177` | 1 | Delete | The fixture and the named slow-shim test already show the wait and delegation. |
| U50 | `tests/helpers/slow-python.cjs:2` | JavaScript | `cd57984e2f205ed2595ae8c25b641ef7e788435db814a374282938a503555b1c` | 1 | Delete | The fixture and the named slow-shim test already show the wait and delegation. |
| U51 | `tests/helpers/slow-python.cjs:3` | JavaScript | `4ceb1221bcab44044a19232766c3058036178e4e5b2825792b43a59af6d4ab57` | 1 | Delete | The fixture and the named slow-shim test already show the wait and delegation. |
| U52 | `tests/helpers/slow-python.cjs:9` | JavaScript | `5e4b5fb0db48bb307160438d38ce8da3b661753843c015818053a12390fc520d` | 1 | Delete | The fixture and the named slow-shim test already show the wait and delegation. |
| U53 | `tests/helpers/slow-python.cjs:10` | JavaScript | `cf9098d87769a943f2e678220c4ba5e0dcb8b93cc5359b8b9629326535635f0d` | 1 | Delete | The fixture and the named slow-shim test already show the wait and delegation. |
| U54 | `tests/kitto.test.mjs:16` | JavaScript | `9f6bc521fa1d3aba463f92177e97e67def066a9d0c337e2d09f623ec35d196a3` | 1 | ADR | The parallel CLI fixture timeout catches hangs, not performance regressions: [ADR 006](adr/006-main-sync-decisions.md). |
| U55 | `tests/kitto.test.mjs:17` | JavaScript | `de4c827e1a32d64f69061f2ace2721d591450fc086f55a2cbd9b708e8b1ef542` | 1 | ADR | The parallel CLI fixture timeout catches hangs, not performance regressions: [ADR 006](adr/006-main-sync-decisions.md). |
| U56 | `tests/kitto.test.mjs:18` | JavaScript | `223c547b1a11acda1c474bfdee4feeb182825e653242721594d44f82b8ba5138` | 1 | ADR | The parallel CLI fixture timeout catches hangs, not performance regressions: [ADR 006](adr/006-main-sync-decisions.md). |
| U57 | `tests/kitto.test.mjs:1769` | JavaScript | `3969f52e4d5add529aedf547eaec425544f8e84dd25084a082578aea92edabe4` | 1 | Delete | [host setup cases](../tests/kitto.test.mjs) already assert advisory/strict behavior and native registration. |
| U58 | `tests/kitto.test.mjs:1770` | JavaScript | `9deb757bee85dbfc7787ca5bbefef802ec7c7ecd087af4b73cb1dd4c43a6081d` | 1 | Delete | [host setup cases](../tests/kitto.test.mjs) already assert advisory/strict behavior and native registration. |
| U59 | `tests/kitto.test.mjs:1782` | JavaScript | `cff2fe344230122fca70cb95ef4384f7646e7fe62c9d7e9152b31ab662b445ff` | 1 | Delete | [host setup cases](../tests/kitto.test.mjs) already assert advisory/strict behavior and native registration. |
| U60 | `tests/kitto.test.mjs:1807` | JavaScript | `532d65c0b3e0092746b0e9eed0d64183060a44ba994bf2407428fd9998a7ff7d` | 1 | Delete | The adjacent tests assert stale removal, live refusal and the separate Pi lock. |
| U61 | `tests/kitto.test.mjs:1808` | JavaScript | `9362b291878f7a607aa3cd6e3fd693b5429b05bc604d82819040caec879e7536` | 1 | Delete | The adjacent tests assert stale removal, live refusal and the separate Pi lock. |
| U62 | `tests/kitto.test.mjs:1815` | JavaScript | `ed643c3c535f9407db784536946512e12000ef13e1812cdf3d6af2044d5dc4bc` | 1 | Delete | The adjacent tests assert stale removal, live refusal and the separate Pi lock. |
| U63 | `tests/kitto.test.mjs:1862` | JavaScript | `b304b7228cd0aeeffccca922c3eeb236d87ce76c99db1f1e472cbe11a284c2b9` | 1 | Delete | The adjacent release tests provide the polling rationale as an executable scenario. |
| U64 | `tests/kitto.test.mjs:1863` | JavaScript | `765c2db50c827e50d9c4d3ae75029e736c22e9e9213df8135afbff9aae93d2f8` | 1 | Delete | The adjacent release tests provide the polling rationale as an executable scenario. |

## Original identities already removed upstream

These location and hash pairs refer to the original baseline, not the upstream target. They are not part of this merge’s deletion subtotal.

| ID | Original location | Language | Raw SHA-256 | Occ. | Disposition | Upstream replacement or rationale |
| --- | --- | --- | --- | ---: | --- | --- |
| R01 | `config/dsh/agent-teams.profiles.yml:7` | Yaml | `3b6504fa972a71988318491bba242b825c22837ab4113e4dfaa297d2ea20a3ad` | 1 | Upstream removed | Upstream replaced the Grok-first sequence with subscription-first setup; [ADR 004](adr/004-native-integration-policy.md) preserves the manual merge, existing settings and restart. |
| R02 | `config/dsh/agent-teams.profiles.yml:8` | Yaml | `6dee09e074b7cac49983e9b5154d8975959677404187e45d099fe3ffb429fb8b` | 1 | Upstream removed | Upstream replaced the Grok-first sequence with subscription-first setup; [ADR 004](adr/004-native-integration-policy.md) preserves the manual merge, existing settings and restart. |
| R03 | `config/dsh/agent-teams.profiles.yml:9` | Yaml | `8d6d8b9615cd3c33175e913717b1df00bd4b90b34c2b8c2c40f2ee80f01479b6` | 1 | Upstream removed | Upstream replaced the Grok-first sequence with subscription-first setup; [ADR 004](adr/004-native-integration-policy.md) preserves the manual merge, existing settings and restart. |
| R04 | `config/dsh/agent-teams.profiles.yml:10` | Yaml | `d5dbc395e42916d2ecd1364e0819caa9e44058782e82d9a9ed562ab3fea47de8` | 1 | Upstream removed | Upstream replaced the Grok-first sequence with subscription-first setup; [ADR 004](adr/004-native-integration-policy.md) preserves the manual merge, existing settings and restart. |
| R05 | `config/dsh/agent-teams.profiles.yml:11` | Yaml | `36c03b05e0f7d7f65ab812249df4b5608afef48f0e4fe0d73bd28e5212baf6a0` | 1 | Upstream removed | Upstream replaced the Grok-first sequence with subscription-first setup; [ADR 004](adr/004-native-integration-policy.md) preserves the manual merge, existing settings and restart. |
| R06 | `config/dsh/agent-teams.profiles.yml:12` | Yaml | `3260d1fe7b55e1a94f862371fee5a2b3095c7e46b9ab431eb95417b6e4fda098` | 1 | Upstream removed | Upstream replaced the Grok-first sequence with subscription-first setup; [ADR 004](adr/004-native-integration-policy.md) preserves the manual merge, existing settings and restart. |
| R07 | `config/dsh/agent-teams.profiles.yml:13` | Yaml | `a1fd3fb87ea5fac156f8c8e9695d51d198d25f8806d43336748e66c2339424e2` | 1 | Upstream removed | Upstream replaced the Grok-first sequence with subscription-first setup; [ADR 004](adr/004-native-integration-policy.md) preserves the manual merge, existing settings and restart. |
| R08 | `config/dsh/agent-teams.profiles.yml:15` | Yaml | `67d010c6998efd419796f93c526c15a5b00e40aba96c96dc32c29e045257617b` | 1 | Upstream removed | Upstream reworded the tool-policy note (U10); [ADR 004](adr/004-native-integration-policy.md) retains the boundary. |
| R09 | `config/dsh/agent-teams.profiles.yml:16` | Yaml | `561ea192e4278a97c5396fa11b29f69cf670699d1ce0f269c5f572d93a83dff8` | 1 | Upstream removed | Upstream replaced the prior role/fallback guidance with current routes and task effort; see the [routing guide](orchestration.md#dsh-侧落地). |
| R10 | `config/dsh/agent-teams.profiles.yml:17` | Yaml | `03f32b01b66063ee78ecfa6a712f337612452e18b68d615d6c0ecb4a96ec1c0c` | 1 | Upstream removed | Upstream replaced the prior role/fallback guidance with current routes and task effort; see the [routing guide](orchestration.md#dsh-侧落地). |
| R11 | `config/dsh/agent-teams.profiles.yml:18` | Yaml | `166df2225268e7c17ff1b632caecba4143decd35f1010d2f1239630961224288` | 1 | Upstream removed | Upstream replaced the prior role/fallback guidance with current routes and task effort; see the [routing guide](orchestration.md#dsh-侧落地). |
| R12 | `config/dsh/agent-teams.profiles.yml:19` | Yaml | `67dc3bf53e40d23c99b7d0f27d18e9eaf468ebc4e286e94795263856a15c0596` | 1 | Upstream removed | Upstream replaced the prior role/fallback guidance with current routes and task effort; see the [routing guide](orchestration.md#dsh-侧落地). |
| R13 | `config/dsh/agent-teams.profiles.yml:20` | Yaml | `6aae418c3d5d89bc3155b0860e05c8b9e8d14997a5e91b825b5852d1dcd1bcb7` | 1 | Upstream removed | Upstream replaced the prior role/fallback guidance with current routes and task effort; see the [routing guide](orchestration.md#dsh-侧落地). |
| R14 | `config/dsh/agent-teams.profiles.yml:22` | Yaml | `67c0faac6998fb6de13f202f25338b26ad27fd73487c0a54e19924b12e4a0847` | 1 | Upstream removed | Upstream dropped the redundant Grok routing header; the [routing guide](orchestration.md#dsh-侧落地) retains Go-only Grok. |
| R15 | `config/dsh/agent-teams.profiles.yml:23` | Yaml | `741b21346572c5e89a8858959ff99881b10bfbf735b7b09de77ed930ba8b09dd` | 1 | Upstream removed | Upstream dropped the redundant Grok routing header; the [routing guide](orchestration.md#dsh-侧落地) retains Go-only Grok. |
| R16 | `config/dsh/agent-teams.profiles.yml:25` | Yaml | `8ccb42661dc6422461e830876fb5c3527fcf436f4fb45e3ed2cba940eb7a4126` | 1 | Upstream removed | Upstream dropped the decorative template section heading. |
