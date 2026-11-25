# Kitto comment audit

Baseline: `4400a587ef93343ec6c5c52d20b7dc8e8468638c`. Counts below describe the cleanup, not a baseline to reuse for future PRs. The two original Actions heredoc comments are included; their owner moved the same commands to [the native CI installer](../scripts/ci-install-native.mjs). The audit also decouples legacy sync help from source positions while preserving its output; the open drafts do not change the other shortcuts.

| Disposition | Original tokens | Treatment |
| --- | ---: | --- |
| Delete | 143 | Remove 130 redundant, stale, or decorative tokens; move the other 13 env/HITL operator notes to their user guides and delete their source comments. |
| Keep | 9 | Retain only the original semantic directives: eight shebangs and one compiler directive. |
| ADR | 294 | Move 270 decisions into ADRs and the 24 legacy help comments into literal CLI data, with the compatibility decision in ADR 001. |
| Issue draft | 26 | Delete the token and document the follow-up. The follow-ups are [#44](https://github.com/phyzess/kitto/issues/44), [#45](https://github.com/phyzess/kitto/issues/45), [#46](https://github.com/phyzess/kitto/issues/46), [#47](https://github.com/phyzess/kitto/issues/47), [#48](https://github.com/phyzess/kitto/issues/48), and [#49](https://github.com/phyzess/kitto/issues/49). |
| Unresolved | 0 | Coverage is 472 of 472 original tokens. |

## Physical lines

| Measure | Before | After | Change |
| --- | ---: | ---: | ---: |
| Scanned source lines, including configuration, tests and the documentation-only YAML at baseline | 14,908 | — | The reproduction prints the live combined scan separately; its delta includes independent ratchet and CI code. |
| Original token-bearing files edited by this audit, excluding the workflow | 12,100 | 11,539 | −561 net physical lines, including 31 from documentation-only compaction YAML. |
| Comment tokens, across the combined inventory | 472 | 9 | −463 tokens; 30 removed inline tokens account for zero physical lines. |
| Comment-only physical lines, across the combined inventory | 594 | 9 | −585 lines of comment syntax, including the 24 reclassified as literal help. |
| Ordinary comment-only physical lines | 585 | 0 | 561 lines disappear outright (559 from the audit, 2 from CI); 24 remain as literal CLI output. |
| New ADRs and local issue records | 0 | 216 | +216: five ADRs, six open drafts, one obsolete draft. |
| [Pi guide](pi.md) / [Pi addendum](../config/pi/AGENTS.md) / [diagnose skill](../skills/diagnose/SKILL.md) | — | — | +38 net guidance lines in existing Markdown. |
| This ledger | 0 | 937 | +937. |

The three compaction pointer edits have zero line delta. Net change attributable to this audit alone (source, user guidance, new ADRs/issue records and ledger) is +630 lines. The source net includes one fewer standalone help-dispatch line and one removed trailing blank env line in addition to 559 outright comment-line removals in audit-owned files. The separate CI extraction removes two comment lines, but its other changes and the ratchet tooling are not included in that net. `physicalLines` counts LF-delimited lines including a final unterminated line; `commentOnlyLines` is a union, not a sum of token heights. Inline removal only loses the comment and any separator whitespace that would become trailing whitespace. See [counting policy](comment-policy.md#audit-and-measurement).

## Protected directives and exclusions

- Eight shebangs and one first-party TypeScript `@ts-nocheck` are semantic and retained unchanged. No ordinary first-party comments remain.
- The 24 former help comments at baseline `sync.sh:2–25` are now one literal `printf` argument; the leading `#` characters in that argument are characters printed to stdout, not Bash comments. Both flags emit the original bytes (24 lines, 1,485 bytes) and exit zero without reaching the deprecation warning. The [help draft](issue-drafts/retire-legacy-sync-help.md) is obsolete; the decision is in [ADR 001](adr/001-configuration-and-host-boundaries.md).
- The nine env notes and four template instructions formerly kept as ordinary comments now live in the [Pi configuration guide](pi.md#pi-环境变量与凭据) and [diagnose skill](../skills/diagnose/SKILL.md). The env assignments and template executable statements are unchanged.
- [`herdr-agent-state.ts`](../config/pi/extensions/herdr-agent-state.ts) is self-managed, not first-party audit material. The **entire** 261-line, 6,694-byte blob `276c964daf6a61f593ab3a8d3f7c1e0ed626d1b1` is unchanged, including its opening metadata and `@ts-nocheck`. Pi sync skips its Linux deployment/export (`sync.sh:179,347` at baseline).
- [`skills/benchmark-checklist`](../skills/benchmark-checklist) and [`skills/writing-for-agents`](../skills/writing-for-agents) are pinned trees; keep bytes and modes intact. They are outside the ledger, not Keep tokens. See [provenance](vendored-skills.md). Markdown prose, licenses, and test strings are not treated as source comment tokens.

## Recompute

Run from the repository root after installing the lockfile dev tools as described in the [comment policy](comment-policy.md). The reconstruction compares ledger identities to both inventories and measures removed physical lines rather than equating token count with line count:

```sh
BASE=4400a587ef93343ec6c5c52d20b7dc8e8468638c
T=$(mktemp -d)
trap 'rm -rf -- "${T:?}"' EXIT
node scripts/check-comments.mjs --inventory "$BASE" > "$T/before.json"
node scripts/check-comments.mjs --inventory worktree > "$T/after.json"
python3 - "$T" <<'PY'
import collections, json, re, subprocess, sys
from pathlib import Path

root = Path(sys.argv[1])
before, after = (json.loads((root / (k + '.json')).read_text()) for k in ('before', 'after'))
files = [{f['path']: f for f in x['files']} for x in (before, after)]
rows = collections.defaultdict(dict)
for line in Path('docs/comment-audit.md').read_text().splitlines():
    if m := re.fullmatch(r'### `([^`]+)`', line):
        path = m[1]
    if m := re.match(r'^\| (\d+):(\d+)–(\d+):(\d+) \| `([a-f0-9]{64})` \| (\d+) \| (Delete|Keep|ADR|Issue draft) \|', line):
        a, c, b, d, h, n, disposition = m.groups()
        key = (int(a), int(c), int(b), int(d), h, int(n))
        assert key not in rows[path], (path, key)
        rows[path][key] = disposition

def location(t):
    return (t['start']['line'], t['start']['column'], t['end']['line'], t['end']['column'], t['hash'], t['occurrence'])

def identity(t):
    return (t['language'], tuple(t['fragment']), t['kind'], t['hash'], t['occurrence'])

old, new = files
assert set(rows) == {p for p, f in old.items() if f['tokens']}
counts, comment_syntax_removed, inline = collections.Counter(), 0, 0
literal_help = 0
local = set()
for path in old.keys() | new.keys():
    tokens = old.get(path, {}).get('tokens', [])
    assert {location(t) for t in tokens} == rows[path].keys()
    keep = collections.Counter(identity(t) for t in tokens if rows[path][location(t)] == 'Keep')
    assert keep == collections.Counter(identity(t) for t in new.get(path, {}).get('tokens', [])), path
    counts.update(rows[path].values())
    deleted = [(a, b) for (a, _, b, _, _, _), category in rows[path].items() if category != 'Keep']
    if not deleted:
        continue
    comment_lines = set(old[path]['commentOnlyLines'])
    expected = {l for a, b in deleted for l in range(a, b + 1)} & comment_lines
    inline += sum(not comment_lines.intersection(range(a, b + 1)) for a, b in deleted)
    diff = subprocess.check_output(['git', 'diff', '--no-renames', '--unified=0', before['snapshot'], '--', path], text=True)
    removed_old_lines = {l for a, n in re.findall(r'^@@ -(\d+)(?:,(\d+))? ', diff, re.M)
                         for l in range(int(a), int(a) + int(n or '1'))}
    assert expected == comment_lines & removed_old_lines, path
    comment_syntax_removed += len(expected)
    if path == 'sync.sh':
        payload_lines = set(range(2, 26))
        assert payload_lines <= expected
        original = subprocess.check_output(['git', 'show', before['snapshot'] + ':sync.sh'])
        help_text = b''.join(original.splitlines(keepends=True)[1:25])
        literal_help = help_text.count(b'\n')
        for flag in ('-h', '--help'):
            help_run = subprocess.run(['bash', 'sync.sh', 'status', flag], capture_output=True, check=True)
            assert help_run.stdout == help_text and not help_run.stderr, flag
    if path != '.github/workflows/check.yml':
        local.add(path)

source_total = lambda fs: sum(f['physicalLines'] for f in fs.values() if f['language'] != 'Excluded')
local_total = lambda fs: sum(fs.get(p, {}).get('physicalLines', 0) for p in local)
new_docs = sum(f['physicalLines'] for p, f in new.items() if p not in old and p.startswith(('docs/adr/', 'docs/issue-drafts/')))
ledger = new['docs/comment-audit.md']['physicalLines']
guides = ('docs/pi.md', 'config/pi/AGENTS.md', 'skills/diagnose/SKILL.md')
guide_delta = sum(new[p]['physicalLines'] - old[p]['physicalLines'] for p in guides)
print('Original source -> current source:', source_total(old), source_total(new))
print('Audit-only edited source -> current:', local_total(old), local_total(new))
print('Disposition counts:', dict(sorted(counts.items())))
print('Original comment-only lines no longer comments:', comment_syntax_removed, '(inline tokens:', inline, ')')
print('Physical comment lines removed outright:', comment_syntax_removed - literal_help, '(literal help lines:', literal_help, ')')
print('New ADR/issue record lines, ledger lines, existing user guidance delta:', new_docs, ledger, guide_delta)
print('Audit-only net:', local_total(new) - local_total(old) + new_docs + ledger + guide_delta)
print('Inventory totals before / after:', before['totals'], after['totals'])
PY
```

## Per-occurrence ledger

The baseline above and each section's path, parser language and fragment apply to every row in that section. Coordinates are one-based physical `line:Unicode code-point column`, with an exclusive end. `SHA-256` hashes the parser token and `#` is the inventory occurrence of the same token within that fragment; neither by itself is a global ID. `fragment: []` means the whole file. A range can cover several physical lines but is one token. `ADR` and `Issue draft` rows each link to their destination; original source links use the immutable commit, so they do not shift after cleanup.

### `.github/workflows/check.yml`

Parser: `JavaScript` · Fragment: `["jobs/test/name:Install validated native hosts", "node:JS:1"]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/.github/workflows/check.yml)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 37:11–37:78 | `fef9dd4116a23bdbb79277f346f436bd94287e453104b5368a45999cf7d3d983` | 1 | Issue draft | Pin-specific shell placeholder requires a separate rebuild. [Destination](issue-drafts/remove-ci-pnpm-placeholder-workaround.md). |
| 38:11–38:80 | `aa0f78fe49b1f831c8e43abc006df20bd2522651fe54c1f280facd4f8f2f4362` | 1 | Issue draft | macOS explains why the otherwise scripts-disabled install makes a narrow exception. [Destination](issue-drafts/remove-ci-pnpm-placeholder-workaround.md). |

### `.gitignore`

Parser: `Gitignore` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/.gitignore)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 1:1–1:12 | `44ac0365746553fce80ce85f2244a1c1fb3f423796969da5734cbd2408936a2c` | 1 | Delete | Obsolete pi-config title predates the broader Kitto package. |
| 3:1–3:10 | `b8b484ddae7a3ec7c88e8ebd44482b3a9fe888a608194d68577b1568285b197a` | 1 | ADR | Keep Pi private MCP definitions out of Git; retain the ignore pattern. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 6:1–6:50 | `2490d3b786459364ccad3101a49bbae2e4d43f50eb27102410d1498e1c154349` | 1 | ADR | Local package/settings/MCP overrides are machine-specific, not export material. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 9:1–9:12 | `6e7ff67902f906edc631b534b502532e25991c95d92660be4b772c287c023462` | 1 | ADR | `.env` holds machine secrets; retain the ignore rule. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 12:1–12:19 | `5b08b81b2640bb4032448ded722dcc0ae9592222b13eeeb57ee316994df41a83` | 1 | Delete | `.codegraph/` identifies the local index directly. |
| 15:1–15:8 | `0f9c2b0ba5177bb6e22372515fca232eae50913e79d6047780ee621ae13fa5c6` | 1 | Delete | `.DS_Store` identifies the macOS artifact directly. |
| 18:1–18:24 | `43e6bdd89d68065acb3eb4d9e13918c74737de1e2817740a6021e4113b149d2d` | 1 | Delete | The `__pycache__/` and `*.pyc` names identify the Python artifact group. |
| 22:1–22:38 | `0342606325a451e37558fd5c1fbba6416cbd4ffb1d8427c9c363867f8290d2da` | 1 | Delete | The `node_modules/` and `*.tgz` patterns identify the artifacts directly. |

### `bin/kitto.mjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/bin/kitto.mjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 1:1–1:20 | `4949218de757741f2174599ad06408d4f369e2da90bbe7f4b32313bd792d7393` | 1 | Keep | First-line executable dispatch selects Node.js; semantic shebang. |

### `bin/maintain.mjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/bin/maintain.mjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 1:1–1:20 | `4949218de757741f2174599ad06408d4f369e2da90bbe7f4b32313bd792d7393` | 1 | Keep | First-line executable dispatch selects Node.js; semantic shebang. |
| 2:1–2:70 | `a631e43e1cc67960d5d08c992a19a10b71f51fec01bf3e57b18b5ecb29527d10` | 1 | ADR | Keep one public CLI; the bundled maintenance skill uses this internal entry. [Destination](adr/001-configuration-and-host-boundaries.md). |

### `config/dsh/agent-teams.profiles.yml`

Parser: `Yaml` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/config/dsh/agent-teams.profiles.yml)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 1:1–1:41 | `047aad8a7264c4b3faff683ea8b802a140f81931f9424233252194e625f4a983` | 1 | ADR | Reference fragment is portable documentation; install and profile state are host-owned. [Destination](adr/004-native-integration-policy.md). |
| 2:1–2:2 | `334359b90efed75da5f0ada1d5e6b256f4a6bd0aee7eb39c0f90182a021ffc8b` | 1 | Delete | Decorative separators without instructions. |
| 3:1–3:61 | `78bc273ac7d949404f3c4d2365433f274a07a28a0cbfaae540d83f1483dafb51` | 1 | ADR | Reference fragment is portable documentation; install and profile state are host-owned. [Destination](adr/004-native-integration-policy.md). |
| 4:1–4:56 | `c9c7dde1ae9629cf1907b0c194ce088e946cfe7570ca98daaaab843392c924cb` | 1 | ADR | Reference fragment is portable documentation; install and profile state are host-owned. [Destination](adr/004-native-integration-policy.md). |
| 5:1–5:16 | `766d75101b125384230c983be1e6ebe9046afefa4436d5808d3265e6be6ebe85` | 1 | ADR | Reference fragment is portable documentation; install and profile state are host-owned. [Destination](adr/004-native-integration-policy.md). |
| 6:1–6:2 | `334359b90efed75da5f0ada1d5e6b256f4a6bd0aee7eb39c0f90182a021ffc8b` | 2 | Delete | Decorative separators without instructions. |
| 7:1–7:6 | `3b6504fa972a71988318491bba242b825c22837ab4113e4dfaa297d2ea20a3ad` | 1 | Delete | Ordering label alone carries no rule. |
| 8:1–8:53 | `6dee09e074b7cac49983e9b5154d8975959677404187e45d099fe3ffb429fb8b` | 1 | ADR | Configure routes before merging `agent-teams`; use an ID merge without dropping required fields or overwriting providers. [Destination](adr/004-native-integration-policy.md). |
| 9:1–9:35 | `8d6d8b9615cd3c33175e913717b1df00bd4b90b34c2b8c2c40f2ee80f01479b6` | 1 | ADR | Configure routes before merging `agent-teams`; use an ID merge without dropping required fields or overwriting providers. [Destination](adr/004-native-integration-policy.md). |
| 10:1–10:54 | `d5dbc395e42916d2ecd1364e0819caa9e44058782e82d9a9ed562ab3fea47de8` | 1 | ADR | Configure routes before merging `agent-teams`; use an ID merge without dropping required fields or overwriting providers. [Destination](adr/004-native-integration-policy.md). |
| 11:1–11:37 | `36c03b05e0f7d7f65ab812249df4b5608afef48f0e4fe0d73bd28e5212baf6a0` | 1 | ADR | Configure routes before merging `agent-teams`; use an ID merge without dropping required fields or overwriting providers. [Destination](adr/004-native-integration-policy.md). |
| 12:1–12:70 | `3260d1fe7b55e1a94f862371fee5a2b3095c7e46b9ab431eb95417b6e4fda098` | 1 | ADR | Apply the manual fragment to a restarted Web profile; link its invocation and approval mode. [Destination](adr/004-native-integration-policy.md). |
| 13:1–13:83 | `a1fd3fb87ea5fac156f8c8e9695d51d198d25f8806d43336748e66c2339424e2` | 1 | ADR | Apply the manual fragment to a restarted Web profile; link its invocation and approval mode. [Destination](adr/004-native-integration-policy.md). |
| 14:1–14:2 | `334359b90efed75da5f0ada1d5e6b256f4a6bd0aee7eb39c0f90182a021ffc8b` | 3 | Delete | Decorative separators without instructions. |
| 15:1–15:50 | `67d010c6998efd419796f93c526c15a5b00e40aba96c96dc32c29e045257617b` | 1 | ADR | Tool visibility does not enforce an OS sandbox. [Destination](adr/004-native-integration-policy.md). |
| 16:1–16:55 | `561ea192e4278a97c5396fa11b29f69cf670699d1ce0f269c5f572d93a83dff8` | 1 | ADR | Preserve subscription boundaries, independent model review, and the fallback disclosure policy. [Destination](adr/004-native-integration-policy.md). |
| 17:1–17:67 | `03f32b01b66063ee78ecfa6a712f337612452e18b68d615d6c0ecb4a96ec1c0c` | 1 | ADR | Preserve subscription boundaries, independent model review, and the fallback disclosure policy. [Destination](adr/004-native-integration-policy.md). |
| 18:1–18:49 | `166df2225268e7c17ff1b632caecba4143decd35f1010d2f1239630961224288` | 1 | ADR | Preserve subscription boundaries, independent model review, and the fallback disclosure policy. [Destination](adr/004-native-integration-policy.md). |
| 19:1–19:65 | `67dc3bf53e40d23c99b7d0f27d18e9eaf468ebc4e286e94795263856a15c0596` | 1 | ADR | Preserve subscription boundaries, independent model review, and the fallback disclosure policy. [Destination](adr/004-native-integration-policy.md). |
| 20:1–20:39 | `6aae418c3d5d89bc3155b0860e05c8b9e8d14997a5e91b825b5852d1dcd1bcb7` | 1 | ADR | Preserve subscription boundaries, independent model review, and the fallback disclosure policy. [Destination](adr/004-native-integration-policy.md). |
| 22:1–22:64 | `67c0faac6998fb6de13f202f25338b26ad27fd73487c0a54e19924b12e4a0847` | 1 | ADR | Configure routes before merging `agent-teams`; use an ID merge without dropping required fields or overwriting providers. [Destination](adr/004-native-integration-policy.md). |
| 23:1–23:58 | `741b21346572c5e89a8858959ff99881b10bfbf735b7b09de77ed930ba8b09dd` | 1 | ADR | Preserve subscription boundaries, independent model review, and the fallback disclosure policy. [Destination](adr/004-native-integration-policy.md). |
| 25:1–25:18 | `8ccb42661dc6422461e830876fb5c3527fcf436f4fb45e3ed2cba940eb7a4126` | 1 | Delete | `id: agent-teams` already labels the template. |

### `config/dsh/compaction.reference.yml`

Parser: `Yaml` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/config/dsh/compaction.reference.yml)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 1:1–1:34 | `0e45d4d6af3bc20fe4a8547af6a422559793b05de8732f6d68a092ca5c75a775` | 1 | ADR | Move non-deployed compaction operating guidance, historical observations and threshold rationale into a durable reference. [Destination](adr/005-dsh-compaction-budget.md). |
| 2:1–2:2 | `334359b90efed75da5f0ada1d5e6b256f4a6bd0aee7eb39c0f90182a021ffc8b` | 1 | Delete | Section separator in the documentation-only file. |
| 3:1–3:30 | `aadf2e7884fe042dcf427af81337ab85532f93d0e27cd885b498edeb301ef8a6` | 1 | ADR | Move non-deployed compaction operating guidance, historical observations and threshold rationale into a durable reference. [Destination](adr/005-dsh-compaction-budget.md). |
| 4:1–4:91 | `613cd03352a577d2502ca4894648f445467e841474e6c6621139fe3695ccfe01` | 1 | ADR | Move non-deployed compaction operating guidance, historical observations and threshold rationale into a durable reference. [Destination](adr/005-dsh-compaction-budget.md). |
| 5:1–5:79 | `30cb9cff334451db2cfc4f48bde4801277a08985f00f962d3475264187c90fa5` | 1 | ADR | Move non-deployed compaction operating guidance, historical observations and threshold rationale into a durable reference. [Destination](adr/005-dsh-compaction-budget.md). |
| 6:1–6:2 | `334359b90efed75da5f0ada1d5e6b256f4a6bd0aee7eb39c0f90182a021ffc8b` | 2 | Delete | Section separator in the documentation-only file. |
| 7:1–7:52 | `cad9bd16fc09dff6ac00f0a7cefb80c783ab3ae525664096c3746143652c3011` | 1 | ADR | Move non-deployed compaction operating guidance, historical observations and threshold rationale into a durable reference. [Destination](adr/005-dsh-compaction-budget.md). |
| 8:1–8:55 | `d1d55b02478bcb228f3731ebe698de5f5e4099b241a15af4767b1f16d230038f` | 1 | ADR | Move non-deployed compaction operating guidance, historical observations and threshold rationale into a durable reference. [Destination](adr/005-dsh-compaction-budget.md). |
| 9:1–9:54 | `9ccf222f868df5be66420c7d331dc6d506198050284e7171f2397db5fe6851c6` | 1 | ADR | Move non-deployed compaction operating guidance, historical observations and threshold rationale into a durable reference. [Destination](adr/005-dsh-compaction-budget.md). |
| 10:1–10:2 | `334359b90efed75da5f0ada1d5e6b256f4a6bd0aee7eb39c0f90182a021ffc8b` | 3 | Delete | Section separator in the documentation-only file. |
| 11:1–11:57 | `01111aa9a9e2e683e4ac9850bee1584374a7da33a1ca90fe55a759326d8baed5` | 1 | ADR | Move non-deployed compaction operating guidance, historical observations and threshold rationale into a durable reference. [Destination](adr/005-dsh-compaction-budget.md). |
| 12:1–12:33 | `a3f8d58b6c672309ec5dd3a57819845ce29c27a7b2696c5ade8460a6af856845` | 1 | ADR | Move non-deployed compaction operating guidance, historical observations and threshold rationale into a durable reference. [Destination](adr/005-dsh-compaction-budget.md). |
| 13:1–13:28 | `f594ed3b7b0f3aa9ac85b368841e0e82dbc1bf23d34e46ed80546c9c428fb053` | 1 | ADR | Move non-deployed compaction operating guidance, historical observations and threshold rationale into a durable reference. [Destination](adr/005-dsh-compaction-budget.md). |
| 14:1–14:24 | `02044273e6f947d6460351b20026365dea17a090c30c823c68c029e2a55d13f7` | 1 | ADR | Move non-deployed compaction operating guidance, historical observations and threshold rationale into a durable reference. [Destination](adr/005-dsh-compaction-budget.md). |
| 15:1–15:50 | `608b4ad3e74a0a3c313510233ac153b56e10992dbf7920c9da298edd3b05e798` | 1 | ADR | Move non-deployed compaction operating guidance, historical observations and threshold rationale into a durable reference. [Destination](adr/005-dsh-compaction-budget.md). |
| 16:1–16:43 | `835dbd8240beaa5f1fe8c3616e52607634d3d317d522e3a7e741239bc69bc852` | 1 | Delete | The example yields 206,464, not below a strict 200,000-token threshold; the ADR gives corrected arithmetic. |
| 17:1–17:2 | `334359b90efed75da5f0ada1d5e6b256f4a6bd0aee7eb39c0f90182a021ffc8b` | 4 | Delete | Section separator in the documentation-only file. |
| 18:1–18:16 | `1b97303de694702fc958209a36789acdd9ed30584d732d01f1d0b2a8b07dd5d9` | 1 | ADR | Move non-deployed compaction operating guidance, historical observations and threshold rationale into a durable reference. [Destination](adr/005-dsh-compaction-budget.md). |
| 19:1–19:59 | `19b80711cfb0ad004b57bf5508bf08698decf4e43c80dc3d6abeb43f374e7749` | 1 | ADR | Move non-deployed compaction operating guidance, historical observations and threshold rationale into a durable reference. [Destination](adr/005-dsh-compaction-budget.md). |
| 20:1–20:63 | `1518f31bb3bcac5879403425347d4f72b688ea1c6223e131d0c6c12eff8c35ae` | 1 | ADR | Move non-deployed compaction operating guidance, historical observations and threshold rationale into a durable reference. [Destination](adr/005-dsh-compaction-budget.md). |
| 21:1–21:48 | `0b3713fdf56e28b6cc51d30afb7623ae8947ee8c9b2ba7c35aee0a628ce09f78` | 1 | ADR | Move non-deployed compaction operating guidance, historical observations and threshold rationale into a durable reference. [Destination](adr/005-dsh-compaction-budget.md). |
| 22:1–22:41 | `f0efd41c858b6bbaa7e564cb27db1d5f66800c11b997a1794bd8f7a6c48d8bd3` | 1 | ADR | Move non-deployed compaction operating guidance, historical observations and threshold rationale into a durable reference. [Destination](adr/005-dsh-compaction-budget.md). |
| 23:1–23:2 | `334359b90efed75da5f0ada1d5e6b256f4a6bd0aee7eb39c0f90182a021ffc8b` | 5 | Delete | Section separator in the documentation-only file. |
| 24:1–24:9 | `90703120e1ea920087b2323032d8af8d6edd4b4426b439801d57cd453e7d2966` | 1 | ADR | Move non-deployed compaction operating guidance, historical observations and threshold rationale into a durable reference. [Destination](adr/005-dsh-compaction-budget.md). |
| 25:1–25:35 | `468eff7bd438447868007cda09070dd1fcf9f956c29ca9daf7e9f6cdcdba24d1` | 1 | ADR | Move non-deployed compaction operating guidance, historical observations and threshold rationale into a durable reference. [Destination](adr/005-dsh-compaction-budget.md). |
| 26:1–26:75 | `2313c457ce4211b6536dce9ba4d8c7b5a42131bdb5470f36f4e9841a80b6fe10` | 1 | ADR | Move non-deployed compaction operating guidance, historical observations and threshold rationale into a durable reference. [Destination](adr/005-dsh-compaction-budget.md). |
| 27:1–27:65 | `2d3125285473bd7f07c356e03a45c8b6c45ee2524ea7b6ab8afeadb18ccc3f4b` | 1 | ADR | Move non-deployed compaction operating guidance, historical observations and threshold rationale into a durable reference. [Destination](adr/005-dsh-compaction-budget.md). |
| 28:1–28:37 | `5556f9db0c962b587fb2313e1b3b476183295a9abc172474b3fa46453fc82881` | 1 | ADR | Move non-deployed compaction operating guidance, historical observations and threshold rationale into a durable reference. [Destination](adr/005-dsh-compaction-budget.md). |
| 29:1–29:2 | `334359b90efed75da5f0ada1d5e6b256f4a6bd0aee7eb39c0f90182a021ffc8b` | 6 | Delete | Section separator in the documentation-only file. |
| 30:1–30:41 | `4274768b8cb6f38e8125e7ea2a73531219003df11f11b2e967195fec3c428e62` | 1 | ADR | Move non-deployed compaction operating guidance, historical observations and threshold rationale into a durable reference. [Destination](adr/005-dsh-compaction-budget.md). |
| 31:1–31:32 | `aaa365726d0eaa4a92716cb8b6e95c5855f8ee1041ff3feab05ff41e3ea6ceaa` | 1 | ADR | Move non-deployed compaction operating guidance, historical observations and threshold rationale into a durable reference. [Destination](adr/005-dsh-compaction-budget.md). |

### `config/env.example`

Parser: `Env` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/config/env.example)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 1:1–1:9 | `2ca9cc155d602c43d40fc0acb6677f27f171a4217620e031e78c600a2b0c2cf1` | 1 | Delete | Explain the template purpose in the [Pi guide](pi.md#pi-环境变量与凭据), not in the assignment data. |
| 2:1–2:43 | `f06950f0ab76f9fcfd5a3372bd9c6846f97bdc2b223e8bbeaccb9d26235d89fd` | 1 | Delete | Explain once-only deployment and existing-file retention in the [Pi guide](pi.md#pi-环境变量与凭据), not in the assignment data. |
| 3:1–3:52 | `0421241fc553000dca7c9ea486f765e665b157b6f5398d9498aa888ecb74a88a` | 1 | Delete | Explain sourcing and exporting the shell assignments in the [Pi guide](pi.md#pi-环境变量与凭据), not in the assignment data. |
| 4:1–4:40 | `b1bc92e8c03fe6df432c1f4a21d9ba34c574e11053adbcc831b0362d4f315b13` | 1 | Delete | Connect shell variables to Pi interpolation of private MCP placeholders in the [Pi guide](pi.md#pi-环境变量与凭据), not in the assignment data. |
| 6:1–6:52 | `af6831f8f4e938c27e88c7925ce0e5dd401a77d9cefd6866ca5214ba5f458798` | 1 | Delete | Identify GitLab, Confluence, Jira and Figma placeholders as private MCP variables in the [Pi guide](pi.md#pi-环境变量与凭据), not in the assignment data. |
| 12:1–12:52 | `525ac151b726affb47e3e69d1eaf715e35bd2df008bca03a4e8d094df44a1d52` | 1 | Delete | Explain usual Pi auth storage and optional env use in the [Pi guide](pi.md#pi-环境变量与凭据), not in the assignment data. |
| 13:1–13:31 | `bd83203ad90ede9907543ec797284ef1a57b614ef487157c36f9ac2880318dc9` | 1 | Delete | Name the optional Anthropic auth variable without enabling it in the [Pi guide](pi.md#pi-环境变量与凭据), not in the assignment data. |
| 14:1–14:24 | `10c6c921e562a89d53bac93a4a3d4bd591af6a5830d3b7b7de304e65f3d98bf6` | 1 | Delete | Name the optional OpenAI auth variable without enabling it in the [Pi guide](pi.md#pi-环境变量与凭据), not in the assignment data. |
| 15:1–15:26 | `ce2f8abab342e575a743d58e3f9692038d701df439508eb8438d0780664a551b` | 1 | Delete | Name the optional DeepSeek auth variable without enabling it in the [Pi guide](pi.md#pi-环境变量与凭据), not in the assignment data. |

### `config/pi/extensions/openrouter-live.ts`

Parser: `TypeScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/config/pi/extensions/openrouter-live.ts)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 1:1–1:15 | `f41fc2ab973675e013d5d5ee7d799ec073a2da86d8bed5b6070cc20029ff6a36` | 1 | Keep | TypeScript compiler suppression retains the extension’s existing checking behavior; revisit in a typing change. |
| 2:1–43:4 | `73e35a471f1a8377f9aa29f64b644c718e33e3cf8ccaf69ef872891b9549ee2d` | 1 | Issue draft | Document current toggles, refresh and inferred-metadata limits in the [Pi operator guide](pi.md#pi-extensions); address the heuristic separately in the [local issue draft](issue-drafts/replace-openrouter-model-metadata-inference.md). |
| 64:1–64:86 | `fecc83dfc2bed90fa5b5b9365ee60c371b73915d274d0bae61b55c1fe92ac874` | 1 | Delete | Registry accessors immediately expose the `state` lists. |
| 77:1–77:78 | `26433ee87ac759a439bab4a65c95f37af87af23332a205e6d05297499df2c70a` | 1 | Issue draft | Mirrored Pi merge, price handling and recency logic could drift when Pi upgrades. [Destination](issue-drafts/replace-openrouter-model-metadata-inference.md). |
| 93:1–93:89 | `ebe237302d21e7e765924267740252161b1aea5983cbae8046bf9e5731179ffe` | 1 | Issue draft | Mirrored Pi merge, price handling and recency logic could drift when Pi upgrades. [Destination](issue-drafts/replace-openrouter-model-metadata-inference.md). |
| 127:1–127:85 | `e177cc199e0542fcf9733b2b2c480a8c3931d61758e01be2d55da8af11930ce0` | 1 | Delete | `applyLive` explicitly names each overridden field and spreads the original model. |
| 137:1–137:94 | `afdbb1f5cbea34ca3661a50fe6768942b6a350baa7f4f85db0e12355d4db9522` | 1 | Issue draft | Synthesis and family-name fallback are the heuristic being replaced. [Destination](issue-drafts/replace-openrouter-model-metadata-inference.md). |
| 201:1–201:88 | `00921bd03eb0303cc4ec00981ee4b78fa201ba6d160718aeee204f6f0d8e0e5b` | 1 | Issue draft | Synthesis and family-name fallback are the heuristic being replaced. [Destination](issue-drafts/replace-openrouter-model-metadata-inference.md). |
| 217:27–217:82 | `34e03cd7e00a6d2ba46c8222ac247e07379de7e43d489af7ff96c71bf18d3cf7` | 1 | Issue draft | Record allowlist/failure semantics that a replacement must preserve. [Destination](issue-drafts/replace-openrouter-model-metadata-inference.md). |
| 275:1–275:90 | `4407a96035e5a7cf65a49c15a3b6e1be999c9be94a4f2e21915e4d82a490c51c` | 1 | Issue draft | Record allowlist/failure semantics that a replacement must preserve. [Destination](issue-drafts/replace-openrouter-model-metadata-inference.md). |
| 296:1–296:79 | `e290c1aab1d7d8f7c6cb09120df3635731ae53704a1a5069ac5345fbbd4311b6` | 1 | Issue draft | Mirrored Pi merge, price handling and recency logic could drift when Pi upgrades. [Destination](issue-drafts/replace-openrouter-model-metadata-inference.md). |
| 375:7–375:82 | `26dbf09176c09a8d9ead9a51ee3309c0e6beac99df206012190b7a05c5941e4f` | 1 | Issue draft | Record allowlist/failure semantics that a replacement must preserve. [Destination](issue-drafts/replace-openrouter-model-metadata-inference.md). |

### `config/pi/extensions/thin-cursor.ts`

Parser: `TypeScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/config/pi/extensions/thin-cursor.ts)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 1:1–17:4 | `7517f73d0d3733b8bca6f6ebc638c401f7cadf464d06dcbacac7fa2005e04888` | 1 | Issue draft | Document prerequisites, cursor-loss risk and disabling steps in the [Pi operator guide](pi.md#pi-extensions); address ANSI rewriting separately in the [local issue draft](issue-drafts/replace-thin-cursor-ansi-workaround.md). |
| 24:1–27:4 | `1eb247f786b8d8854d86735d84247e37222ad20c8a23c3a3f5bd27d8abd592ca` | 1 | Issue draft | Preserve glyph width and trailing reset while replacing ANSI post-processing. [Destination](issue-drafts/replace-thin-cursor-ansi-workaround.md). |

### `integration/dsh-archive-review.mjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/integration/dsh-archive-review.mjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 13:5–13:76 | `444c452cb5edcbaf6ecb4479549840d6a2c04c67819c218d91cb25510c15d091` | 1 | ADR | Projected shell env is not proof of Web launcher identity; use `profileContext`. [Destination](adr/004-native-integration-policy.md). |
| 14:5–14:81 | `50cf8c01b2aa1b57a885e8ea6ab285bdb2c2b037db0af23a0b518210cda60f60` | 1 | ADR | Projected shell env is not proof of Web launcher identity; use `profileContext`. [Destination](adr/004-native-integration-policy.md). |
| 39:11–39:88 | `07a2698256f7b14521a18a5ac0934468fbf956a9368d70c6805a0327b7b3f769` | 1 | ADR | Reload/unarchive must read the durable archive registry and avoid host-event conversation writes. [Destination](adr/004-native-integration-policy.md). |
| 40:11–40:87 | `036f0600520e271f75300a69cc30e09cff707faffea387df96cd9334cdffa6bf` | 1 | ADR | Reload/unarchive must read the durable archive registry and avoid host-event conversation writes. [Destination](adr/004-native-integration-policy.md). |

### `integration/dsh.mjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/integration/dsh.mjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 8:1–8:68 | `972f3e94a14b0834f5fe7379e83432181a77ab0ec0817693dbc3a72887b19eaa` | 1 | ADR | Startup catalog is intentionally cheap; load the one skill body only on demand. [Destination](adr/004-native-integration-policy.md). |

### `integration/pi.mjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/integration/pi.mjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 5:1–5:83 | `d135625533d4f99bf6312fddb3993b60c258d2dbb7b6c93d2e112e85581074aa` | 1 | ADR | Host ownership and non-blocking startup make an automatic upgrade inappropriate. [Destination](adr/004-native-integration-policy.md). |

### `integration/scoped-dsh/index.mjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/integration/scoped-dsh/index.mjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 13:5–13:65 | `cba1d37e4d9ef4b67c2256ccd9b669a07b50cc902451cd782e6390221ab91fc3` | 1 | ADR | Match native instruction size ceiling rather than adding an independent limit. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 58:15–58:82 | `c11c9e3b4182311c0f3f403d49d036d698cf72161060431257ea87c7feb3dc5f` | 1 | ADR | Native project skills take priority over appended scopes. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 89:7–89:75 | `3884189be7dde3e55fc6e65c505dfb9d15dfa1b751a5f18a922642fa4138c65d` | 1 | ADR | Built-in instruction chain must not be duplicated. [Destination](adr/001-configuration-and-host-boundaries.md). |

### `integration/scoped-dsh/native.mjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/integration/scoped-dsh/native.mjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 8:1–8:78 | `4ab983555c9f74cacc151ecb10471dee7e65afa6e9e31876f1f3bbe38332d59d` | 1 | Issue draft | Real launcher discovery depends on brittle mise shim layout and `mise which`. [Destination](issue-drafts/stabilize-host-adapters.md). |
| 33:1–33:80 | `722ad136562aaa46492f971977483e29ff0d8ac02902bf95da14860ee4f9abf3` | 1 | Issue draft | Resolve against the identified DSH install; selecting the wrong module base can fail or drift. [Destination](issue-drafts/stabilize-host-adapters.md). |

### `integration/scoped-pi/index.mjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/integration/scoped-pi/index.mjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 26:7–26:91 | `072e7af731694b9ea2aa123a5a9906e2f00f9435bca3c376bbbef613d006c74e` | 1 | ADR | Pi's first-match skills require native-first and innermost-scope precedence. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 41:7–41:96 | `f47a7b7561fd80aeafeb5541f295298db2636b8f153c8f58b01fb2d8e26cb372` | 1 | ADR | Preserve native context and deduplicate scoped paths. [Destination](adr/001-configuration-and-host-boundaries.md). |

### `lib/codegraph.mjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/lib/codegraph.mjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 25:15–25:33 | `aed6d9d17dd64ff658e98b2c32deffb15de9812aca83d4fa298429bd0f2cb76c` | 1 | Delete | The next line walks to the parent after a failed stat. |
| 43:1–43:82 | `6ce251aba84685155380ae87b02ccfabaeba6a5357e5759dba688ba2edfddbc6` | 1 | Delete | `codegraphTargets` names its result, and the body builds it from registered roots. |
| 94:1–94:57 | `64f5dd6feb0e1fdab0fc6633537b6e33c36ca2ffba32ea510ffbd16a760220e7` | 1 | Delete | `reportCodeGraphIndexes` and `ensureCodeGraphIndexes` distinguish preview and apply directly. |
| 106:1–106:65 | `634296cd0f2deada4713ab27bf1ca6d489a28104f5aceb52b918332ec68d904d` | 1 | Delete | `reportCodeGraphIndexes` and `ensureCodeGraphIndexes` distinguish preview and apply directly. |

### `lib/codex-mcp.mjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/lib/codex-mcp.mjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 11:1–11:78 | `440518f82e772be18ff43591cb50fe5f28aef620ed0e82fa8c7a33bf33b739e2` | 1 | ADR | Refuse lossy field/auth translation; only explicitly selected machine overlays may feed the portable plan. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 12:1–12:74 | `16d2941a4c1ee0d47b671596a0d3f931c5d286ed64960d4ac4dc483788345aab` | 1 | ADR | Refuse lossy field/auth translation; only explicitly selected machine overlays may feed the portable plan. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 13:1–13:79 | `f9210b95901b33c28f5e4e992bbe14b6d6e605dd6703f7fa78542c50bf14d536` | 1 | ADR | Refuse lossy field/auth translation; only explicitly selected machine overlays may feed the portable plan. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 14:1–14:71 | `15a799a33110ae360781e883244819944b7562188cd8f5b6175c4623e99b90eb` | 1 | ADR | Refuse lossy field/auth translation; only explicitly selected machine overlays may feed the portable plan. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 16:1–16:81 | `c828c29bf5e72eae9eabca505a482215c7f464a42fc5106dc3dfe619c5edacbb` | 1 | Delete | The accepted-name regex and its branch enumerate and diagnose the allowed set. |
| 17:1–17:68 | `608bcf3bbda7473bcbd6768c8658ac2d2ea425c42edfb6aee5503a238fdfbd09` | 1 | Delete | The accepted-name regex and its branch enumerate and diagnose the allowed set. |
| 50:1–50:71 | `462ec3c4f0c7106fde4284e817502b5298c65176f1e464d9a7f54117662de49e` | 1 | ADR | Ownership depends on transport plus presence/extra fields; reconcile stale and pending records. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 55:1–62:4 | `00fb8c34432b535478dbc1b155c4abd6747f743823e4fa262f9ed5b8c249d923` | 1 | ADR | Refuse lossy field/auth translation; only explicitly selected machine overlays may feed the portable plan. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 71:3–71:82 | `ff36a8dd1561c29495267b7421efe8c3682906ba01b12bcbbc92dc8466f93907` | 1 | ADR | Refuse lossy field/auth translation; only explicitly selected machine overlays may feed the portable plan. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 72:3–72:69 | `27001ec1f009f1911f92ba34bca5a97d79d45c2b8030321d1f00b5f29f399580` | 1 | ADR | Refuse lossy field/auth translation; only explicitly selected machine overlays may feed the portable plan. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 133:1–137:4 | `f69fada94ff3d8e6ff07ac1a771d560dfa3d4f9f3caa5f5bd6dc7eb5a3d51017` | 1 | ADR | Refuse lossy field/auth translation; only explicitly selected machine overlays may feed the portable plan. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 180:1–180:79 | `d0aeb54bf2294d31f6de420f73195a89543ff721d9d13957907a974a3cbd23b2` | 1 | Delete | `liveTransport` and returned fields identify normalization. |
| 201:1–204:4 | `b6888646a9b1a72550f67c135142e0595d1caa6ffb579b72bad3774beb4607d6` | 1 | ADR | Ownership depends on transport plus presence/extra fields; reconcile stale and pending records. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 243:1–246:4 | `69ca61dc477d9032b66b8e91d1d06e3a84fc6da03b424b343a734fba2779d1d1` | 1 | Delete | Planner takes inventory, fingerprints and optional details as named inputs. |
| 299:3–299:77 | `2261e9228bb6c984430f2d2bf7a9bd511ee75946caf4172e461baf426aa9a979` | 1 | ADR | Ownership depends on transport plus presence/extra fields; reconcile stale and pending records. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 300:3–300:33 | `8eb029b36079d12ce29f1b6f68e35668da34a17ca925a53a34d1e03dbe7bb142` | 1 | ADR | Ownership depends on transport plus presence/extra fields; reconcile stale and pending records. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 325:3–325:79 | `fa2a0179398297198971da5e3055bbefc0a123fa7435a89dd79f81979195208e` | 1 | ADR | Ownership depends on transport plus presence/extra fields; reconcile stale and pending records. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 326:3–326:78 | `447ae41012b500ab250e98576156e9bceedb9c37014ffa5fc6c1b7ad5429afc4` | 1 | ADR | Ownership depends on transport plus presence/extra fields; reconcile stale and pending records. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 331:3–331:82 | `708b4e645f622f43c1958f82f0373e49863831b5b6035d25b08145ab476fc720` | 1 | ADR | Ownership depends on transport plus presence/extra fields; reconcile stale and pending records. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 332:3–332:67 | `96bcec0d84d0ff0fef48fb3f0594f24ddb91f661c01adf6cec393d4c3015ca1d` | 1 | ADR | Ownership depends on transport plus presence/extra fields; reconcile stale and pending records. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 336:43–336:88 | `5a290681ca6bd9bd900eb7a97f1bee2a00b62140716b3186654fa364ad26a01a` | 1 | Delete | The preceding source loop already handles still-declared entries. |
| 363:1–363:60 | `a48641f5bb8a56829cb32f52c51c443f5dea8c38d7a16c4ef24f3df3370706dc` | 1 | Delete | Removal function names and plan shape explain scope. |
| 400:1–400:79 | `e9eed2bfb3ae28c49d61fa9a62b99cdb32ca73a35d4cfa6889461dddd9227224` | 1 | Delete | Spawn result checks and return statement define the same contract. |
| 405:5–405:82 | `59d1af61c79eaf2f5db010f97ea4359c267163507adf6fd26707ba66ef7190ae` | 1 | ADR | Native failures should not echo argv or values that may contain credentials. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 406:5–406:78 | `e0e2069382feed7fb56c1bcecc88a6ba04fa3f1ca0953c164e806ffc4536a1ae` | 1 | ADR | Native failures should not echo argv or values that may contain credentials. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 421:3–421:81 | `c0f77c4d94ac9072ac43ccbe96b17469bf4ae008423f49b510d7ff27e7a8c0dd` | 1 | ADR | Read via scratch home; a missing home needs no side-effecting probe. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 422:3–422:61 | `172933bc187b07ea59e79387939536bb4dd3b955ce7582a50c0d59a722816244` | 1 | ADR | Read via scratch home; a missing home needs no side-effecting probe. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 454:1–457:4 | `8a598544e5ff2d97bdf8cfb783f73fab9c30d4fb01d868949aa478172e7ee7e5` | 1 | ADR | Read via scratch home; a missing home needs no side-effecting probe. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 492:1–492:75 | `616e1569ee44c37fb766142d9865da3fa040450603883954a2c529c22e4476c7` | 1 | Delete | The `planCodexMcp` name and `withLive` call make the dry-run path visible. |
| 517:1–517:65 | `8d488714f9b9c57a9eac26638e4f03e27e557decc187460bd8e381bb8016b257` | 1 | ADR | Persist provisional ownership before native writes so retry can recover an interrupted add. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 541:1–545:4 | `ec808a87b444e7001ab32d07118b62c1c2c2d60f84ed242e707280c750b6b81c` | 1 | ADR | Persist provisional ownership before native writes so retry can recover an interrupted add. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 557:7–557:80 | `d5924e965611ed85305445fe27b64823ccc9c6d2303414fb887e473af40d4e36` | 1 | ADR | Apply needs an explicit skipped-server warning even without a separately printed preview. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 558:7–558:80 | `8be5a7d8b3a6dc56615ff91576452712720c065fb581ac47c1bce5e8d6471fc3` | 1 | ADR | Apply needs an explicit skipped-server warning even without a separately printed preview. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 576:7–576:80 | `0104541d58f1dc546166320077ecab1edf2135efd9bb195eddd9eb87bd6a2e45` | 1 | ADR | Persist provisional ownership before native writes so retry can recover an interrupted add. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 577:7–577:79 | `f5dd0f86363422a87f9be3855c917390759fe77cb75fa7cb49311e4014a6bb63` | 1 | ADR | Persist provisional ownership before native writes so retry can recover an interrupted add. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 583:9–583:81 | `f06a52fd1db2ec69b8f542972c78cdca2c3225afc8d74d05f9d4abf0685d99bb` | 1 | ADR | Discovery may fail after write; adopt an exact transport match and otherwise surface the original native error. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 584:9–584:82 | `34c733f4fe4cfeb994eb3489094986f2e6e221cfa81a15206bc234e176e65ac3` | 1 | ADR | Discovery may fail after write; adopt an exact transport match and otherwise surface the original native error. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 591:19–591:55 | `5ba9feda192d3e866967389fc1a8ab2b8531331f23c27c84e2d951d0fae4baf6` | 1 | ADR | Discovery may fail after write; adopt an exact transport match and otherwise surface the original native error. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 653:3–653:81 | `681bf7cb01e8927a2ce19a22b9c245e3a7a58a7c7e772fbc11439c7f048f19e0` | 1 | ADR | Pending records must not outlive the live server they evaluated. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 654:3–654:46 | `8e6a104a795f4509ebc1bdc19306bfa756e97f4a072bd10c1b621463ddcd54ca` | 1 | ADR | Pending records must not outlive the live server they evaluated. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 684:1–684:71 | `982a3ec29482052529304fc6ad002dd6878fbc38ed803d4db7e897baf52ff1ea` | 1 | Delete | Removal function names and plan shape explain scope. |

### `lib/dependencies.mjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/lib/dependencies.mjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 32:3–32:84 | `78c5803ccdf9aca6fcbb3b04e1d0aa30562f6f5b36fb3f340fa54fa01386e8c0` | 1 | ADR | A deployed MCP file reflects local choices and takes precedence for dependency resolution. [Destination](adr/001-configuration-and-host-boundaries.md). |

### `lib/dsh-profile.mjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/lib/dsh-profile.mjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 6:1–6:80 | `218a6322edfdb459e6df9a79058bf01a5b5e865b1298d95cfa137d89db7bbb40` | 1 | ADR | Desktop is app-managed; isolate a read probe and distinguish absence from probe errors. [Destination](adr/004-native-integration-policy.md). |
| 19:1–19:72 | `f42616ae22cbf23201c425c0d0f569d55a756999a217736a1bd55db04f5a20c0` | 1 | Delete | Validation/report function names and branches already explain the operation. |
| 45:1–53:4 | `fd2e87ba6c116c6e2cbc6b8a0b98285854e5566dface87b4c98b36281b6ab80b` | 1 | ADR | Desktop is app-managed; isolate a read probe and distinguish absence from probe errors. [Destination](adr/004-native-integration-policy.md). |
| 87:17–87:50 | `7d1318206823cb1b56203a726eda9d58e104988433e640b1ea8fbeec1989860f` | 1 | Delete | The surrounding JSON branch already treats non-reports as fallthrough. |
| 97:1–97:61 | `5667a7e1e4f33eae0b23abc0b96b463533cf9d6d76ab2cc36d2a1c8dafa8583a` | 1 | Delete | Validation/report function names and branches already explain the operation. |

### `lib/environment-setup.mjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/lib/environment-setup.mjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 29:5–29:101 | `d0c3ea8e764173732445ae3aff3e87db57fd6d646bb52e2252a99be852d4c4e9` | 1 | ADR | Missing DSH CLI during a planned install defers module-dependent preview work. [Destination](adr/004-native-integration-policy.md). |
| 32:7–32:75 | `e5ba956ccfaeda1c6cbb70008569b03852b662a1ff76a05c180b30a55d75b0b8` | 1 | ADR | Desktop must not receive a scope adapter. [Destination](adr/001-configuration-and-host-boundaries.md). |

### `lib/host-config.mjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/lib/host-config.mjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 11:1–11:81 | `6934e1609bad743fadc7c74e1d09ab59ef9e2583e76f18627b903734ff65b397` | 1 | ADR | Normalize on the same cross-language boundary and legacy path; prefix inference is unsafe. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 12:1–12:79 | `4b0b3237a7454dfd7f6953b351e244066505a28b1faeba3f181ad19a0c6287c8` | 1 | ADR | Normalize on the same cross-language boundary and legacy path; prefix inference is unsafe. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 13:1–13:78 | `f5d72d3cbc56444d49762e58d01631ecc1199492e3d361a12b9042f9b132517a` | 1 | ADR | Normalize on the same cross-language boundary and legacy path; prefix inference is unsafe. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 16:1–16:71 | `46d958f4b0494eb047397372c55cddd202829abdabaf06831ae9f4f528e69a65` | 1 | ADR | Normalize on the same cross-language boundary and legacy path; prefix inference is unsafe. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 21:1–21:74 | `4df9787a94a901d3d946b88b8937829c6b2d966c7d3d967c5adcb7530a37f5dd` | 1 | ADR | Normalize on the same cross-language boundary and legacy path; prefix inference is unsafe. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 22:1–22:80 | `6c20e21d9db835fa648f79bdcb5d19471da35dd123e97c91da007cd83cf36a72` | 1 | ADR | Normalize on the same cross-language boundary and legacy path; prefix inference is unsafe. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 23:1–23:78 | `7c4434dc76136d7b8480deebe3de131c4d518015aaabca78ac68a54372709869` | 1 | ADR | Normalize on the same cross-language boundary and legacy path; prefix inference is unsafe. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 24:1–24:41 | `9f3cc92db3a832c5db62435bea6a903e35c43d11c579a6f565d90a2f1565de8e` | 1 | ADR | Normalize on the same cross-language boundary and legacy path; prefix inference is unsafe. [Destination](adr/001-configuration-and-host-boundaries.md). |

### `lib/hosts.mjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/lib/hosts.mjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 9:1–9:80 | `99c5153fd2463f4b40e4ebd9ef9ddca7981efd500cd3867753b2f3cb7fd6ba7a` | 1 | ADR | Explicit validated pins are not a background upgrade or dist-tag follower. [Destination](adr/004-native-integration-policy.md). |
| 10:1–10:71 | `d904d23624501065d823008f875034092fb3b41fbcc8a79e5d926492e61aafb0` | 1 | ADR | Explicit validated pins are not a background upgrade or dist-tag follower. [Destination](adr/004-native-integration-policy.md). |
| 53:1–53:80 | `7805de3cea935341ed53a2d8e75bdfbea41a224d3a0c079f156205c5c74c0ab6` | 1 | ADR | Codex version checks must avoid changing the user's home. [Destination](adr/004-native-integration-policy.md). |
| 54:1–54:71 | `d56a30ad5671c9ae2a0f505ffeaa2a73547fb125623fe13454a0d82f698f1b5f` | 1 | ADR | Codex version checks must avoid changing the user's home. [Destination](adr/004-native-integration-policy.md). |
| 77:1–77:81 | `799ca166694acf523309dde7aa3b14585ebce88d1f441b924ec393fac4ee24ee` | 1 | Issue draft | Dependency-free version ordering is independently implemented and can drift across entry points. [Destination](issue-drafts/stabilize-host-adapters.md). |
| 78:1–78:82 | `2d3e8443171b87c5dfa7580e0e0e0da7ef3c2dea09fb7dd1b843977309437c53` | 1 | Issue draft | Dependency-free version ordering is independently implemented and can drift across entry points. [Destination](issue-drafts/stabilize-host-adapters.md). |
| 79:1–79:79 | `fa2f879e426952ea9fe08bd759910b5aea3edaa012246fcf60cf4b5ab75aead8` | 1 | Issue draft | Dependency-free version ordering is independently implemented and can drift across entry points. [Destination](issue-drafts/stabilize-host-adapters.md). |
| 202:3–202:80 | `8467c03ff5f9955a76aa8d847083912f879d5a82bd81e068f60d0d4246216b59` | 1 | ADR | Preserve useful install progress and prefix/permission error reporting. [Destination](adr/004-native-integration-policy.md). |
| 203:3–203:71 | `f7a195a71f9c1e741a55cb5c574336d1be3c0f40d3babd2e8eeb869a49359127` | 1 | ADR | Preserve useful install progress and prefix/permission error reporting. [Destination](adr/004-native-integration-policy.md). |
| 231:5–231:81 | `f8fb4f3f40acd2184813541c6d0eee1d9066cd3ba61a94d910b686c2adceac92` | 1 | ADR | Unvalidated override warnings are required even if apply is a no-op. [Destination](adr/004-native-integration-policy.md). |
| 232:5–232:75 | `afb3015ce64988fb4d352c818ec8f44e0675ced82c60c4d36e7cd829641cf6dc` | 1 | ADR | Unvalidated override warnings are required even if apply is a no-op. [Destination](adr/004-native-integration-policy.md). |
| 281:1–281:74 | `75e8a7d750c0c980dca12c1949734115b036f27253f74f351beb6a7588f1a753` | 1 | Delete | Public command options are available in command usage, and belong there. |

### `lib/kitto.mjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/lib/kitto.mjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 23:39–23:84 | `48c744b8ef5d96270efec278938a8aa6921f95917fd298a29e84f81097f4dab2` | 1 | ADR | pnpm pin serves the native DSH plugin manager. [Destination](adr/004-native-integration-policy.md). |
| 25:1–25:77 | `f3b879c1746702ab6d6dae7af4b90331af1a593d33f178075b99225c3f42a952` | 1 | ADR | Persist safe runtime/recovery coordinates and ownership; use staged writes and restore only verified checkpoints. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 26:1–26:75 | `f70e6d010cce5b56855bfff9ee8a58af3c64a56c3c6b2847939ab595a36a2281` | 1 | ADR | Persist safe runtime/recovery coordinates and ownership; use staged writes and restore only verified checkpoints. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 30:3–30:70 | `546ca0a998c350f0608d2d5a4a7d3810a167fa374551b350e97392035bb988d7` | 1 | ADR | Persist safe runtime/recovery coordinates and ownership; use staged writes and restore only verified checkpoints. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 39:1–39:76 | `9a3cd5e97c6fdd3eff08c55201fe67b74bfffe63eb8c2081ac30256d1af0bee4` | 1 | ADR | Persist safe runtime/recovery coordinates and ownership; use staged writes and restore only verified checkpoints. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 126:1–130:4 | `b7a9dd579d9a2743f65e4af522d7c08e2c28b54e88e0e14c48a89de944b97571` | 1 | ADR | Prerelease ordering is part of validated host eligibility, not just numeric version matching. [Destination](adr/004-native-integration-policy.md). |
| 147:3–147:60 | `598bb303d9740d7be7144817826215e95aecb049dfa680c45202a49022f8f74f` | 1 | ADR | Prerelease ordering is part of validated host eligibility, not just numeric version matching. [Destination](adr/004-native-integration-policy.md). |
| 167:3–167:76 | `8bedc4ceed338424659baa75559f1febe5bc497e72c295c481f332d1e2ab09d8` | 1 | ADR | Read-only Codex probes need scratch homes even for version/help. [Destination](adr/004-native-integration-policy.md). |
| 168:3–168:77 | `f9b58451be5b3b79ae88fb6c0900a441b1671509024256d2bc9564c715459b4d` | 1 | ADR | Read-only Codex probes need scratch homes even for version/help. [Destination](adr/004-native-integration-policy.md). |
| 191:3–191:69 | `40124808d80aeb71865565ec347640d1c17f36425d650c152d4ec38444697089` | 1 | ADR | Read-only Codex probes need scratch homes even for version/help. [Destination](adr/004-native-integration-policy.md). |
| 219:3–219:80 | `a2739f16ee3f2a703d0ef1dd1a4dbb4a093491d479619fb6e70f78bd68e6ea5e` | 1 | ADR | Persist safe runtime/recovery coordinates and ownership; use staged writes and restore only verified checkpoints. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 231:3–231:83 | `a85b474129f9f11749be2b0286f760301dd912dd2bd92de4da470fb971381f47` | 1 | ADR | Persist safe runtime/recovery coordinates and ownership; use staged writes and restore only verified checkpoints. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 250:3–250:76 | `53c90025a09ac98b2819d99bb81ece19c675feb577ac8ab6925971c16b0b6dd0` | 1 | ADR | Persist safe runtime/recovery coordinates and ownership; use staged writes and restore only verified checkpoints. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 422:3–422:80 | `7f23f14a6770dde3ec0e4d3f323947f48fc75fc491b43a22d934837c3890285a` | 1 | ADR | Persist safe runtime/recovery coordinates and ownership; use staged writes and restore only verified checkpoints. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 473:5–473:81 | `598358c4d9fe4398405c22251a5cff00c0f44b3ee359bb5a6f043320563c63c9` | 1 | ADR | Migration removes only the former Kitto-managed path remembered as machine-only. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 520:3–520:60 | `812fbb7775be9e655b0ebca2dafed2af73cff25366a286d2b5e6f506f4d3947d` | 1 | ADR | Detach preflights all remaining hosts before making a change. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 522:3–522:85 | `a95678397a205d7b5ccf62666887282db2b2cf3c84d20c887d0ebb11305d3102` | 1 | Delete | The quiet flag is visible and the per-host change path reports separately. |
| 537:1–537:81 | `59d04366abd4cb33de90ce14ef38af2ee2c4cbd1a8dc6dc71a8fb552e68eb7f7` | 1 | ADR | Updating Kitto code never upgrades host CLIs. [Destination](adr/004-native-integration-policy.md). |
| 538:1–538:79 | `c2508ba8f954de086d5f34b330483b7eb7b99705c9390ff965a5b6b0b5152520` | 1 | ADR | Updating Kitto code never upgrades host CLIs. [Destination](adr/004-native-integration-policy.md). |
| 547:5–547:71 | `40124808d80aeb71865565ec347640d1c17f36425d650c152d4ec38444697089` | 2 | ADR | Read-only Codex probes need scratch homes even for version/help. [Destination](adr/004-native-integration-policy.md). |
| 563:3–563:82 | `3033f7966f4e4bdf25686fdf55180fdf03a14e788a5e7821e4f97c0885919406` | 1 | ADR | An executing installed Kitto cannot replace itself; interrupted deploy cannot replace the last verified checkpoint. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 564:3–564:42 | `34f353c8ab3fb5b2f5b83d5edd1b1c6626c0b350ea44293392d897b401675573` | 1 | ADR | An executing installed Kitto cannot replace itself; interrupted deploy cannot replace the last verified checkpoint. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 583:3–583:81 | `6477172a4a706c1df832dc9b222adfd5e8347647b8ace15dd163b69a5da9553f` | 1 | ADR | An executing installed Kitto cannot replace itself; interrupted deploy cannot replace the last verified checkpoint. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 584:3–584:78 | `be459154d22fb0f35852356b9a1ab4dc13586820bd879fab356b5bdcbc244bd9` | 1 | ADR | An executing installed Kitto cannot replace itself; interrupted deploy cannot replace the last verified checkpoint. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 585:3–585:51 | `59503e664f8ed759693ccca09db52e3da8ea3e852dde2697e4982a8c1eae6c35` | 1 | ADR | An executing installed Kitto cannot replace itself; interrupted deploy cannot replace the last verified checkpoint. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 621:1–621:91 | `d643b82b911e6c7e2ce179ea44fa537affdc7f634ea1e23c74a6a7b84ebb1dd5` | 1 | ADR | Preview and apply agree on recovery ref; follow recorded origin changes; allow local-ahead but not divergence. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 637:1–637:83 | `29566510f0229a9d54a137d255b3a147599ab13ccfa1c0c9245e5e350ff14f99` | 1 | ADR | Preview and apply agree on recovery ref; follow recorded origin changes; allow local-ahead but not divergence. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 658:1–658:81 | `03dd48292e45c62ba55af8d7ba12f7a6cea7c1c2fd9708e9bf4ab61d8d7150d0` | 1 | ADR | Preview and apply agree on recovery ref; follow recorded origin changes; allow local-ahead but not divergence. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 699:3–699:78 | `a4d4463bf9c9d2840c8a9be48acccf1df2c6c99a72f08cfdb168379061126ab7` | 1 | ADR | Preview and apply agree on recovery ref; follow recorded origin changes; allow local-ahead but not divergence. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 700:3–700:83 | `8c80e0815f1c8590413b04ccbba5f13df150047e82bfd26cf5e61e42818a0944` | 1 | ADR | Preview and apply agree on recovery ref; follow recorded origin changes; allow local-ahead but not divergence. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 715:1–715:87 | `e923ec5a74b2e3f864954be2ce86fad85a958cabeabe24df67fceb4b64653686` | 1 | Delete | User-facing update help defines the same options. |
| 734:5–734:81 | `fee0a31d1398b1c426b523fb66b5aab6ba471a11c1a62e6876a4acf27dbf9982` | 1 | Delete | The “only after success” claim is false: `deploy` writes provisional state before native deployment. |
| 735:5–735:72 | `83fce3209a72db9f06e3f7dc83a89a7052c525bb9f6a90e6637fdf68948d82c1` | 1 | Delete | The “only after success” claim is false: `deploy` writes provisional state before native deployment. |
| 750:5–750:70 | `2324535e00155a5ba9c6fcdba94d161bd1ca75c7e3416eb45dce804bf3abcd69` | 1 | ADR | Resolve conflicts before refresh; deployment runs the code loaded at process startup. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 753:5–753:80 | `b7ef9b5eb297d6ebb0fc5cbfb2d834709a50b560624e65193f8aae0a154eb015` | 1 | ADR | Resolve conflicts before refresh; deployment runs the code loaded at process startup. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 754:5–754:71 | `0fd0be8c1bac2b3cf9d4509f961c53e43141911a89d5c57d69ea0db27d10c08b` | 1 | ADR | Resolve conflicts before refresh; deployment runs the code loaded at process startup. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 810:3–810:89 | `35dead8a4cdc92a2cebe64c2eb75db184e61e9b7303cc8e2dd9ff9221a15b214` | 1 | ADR | Desktop ownership excludes CLI/package prerequisites and native profile mutations. [Destination](adr/004-native-integration-policy.md). |
| 825:5–825:88 | `ea197963089eacc579a41713ed8fbc5e5a3c98c7aa785280ebec05be404c9b34` | 1 | ADR | Use canonical paths and replay only verified managed source information, with explicit ref precedence. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 855:3–855:82 | `07b9d6792fb6e8590b0cfefc72f82ab535c96f420f9ec0ccadf84f7cde36bfa2` | 1 | ADR | Use canonical paths and replay only verified managed source information, with explicit ref precedence. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 856:3–856:83 | `a8c7d98a049c828038c2b40b13d3861dd1fb26272e2c633d3f54432b3462697b` | 1 | ADR | Use canonical paths and replay only verified managed source information, with explicit ref precedence. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 857:3–857:82 | `2af5aef966ea98fa65e2aefc5f442c858caf04219b15175db3cf66c3b1973b90` | 1 | ADR | Use canonical paths and replay only verified managed source information, with explicit ref precedence. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 860:3–860:79 | `31ea7a2b460d9f5a80cdacb803f5e4e6d141f0fbaca185f149a2a7b2ce8a7626` | 1 | ADR | Use canonical paths and replay only verified managed source information, with explicit ref precedence. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 861:3–861:82 | `bce14669ad20f2b2baa5a6eb60802496382f096bbb6f1f50da5ea0ad9927f7fb` | 1 | ADR | Use canonical paths and replay only verified managed source information, with explicit ref precedence. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 864:3–864:90 | `2cff59cc16fcd1aea953e5f1953dd2b4cfb9e205e935fec9bdb8baecfadd594d` | 1 | ADR | Desktop ownership excludes CLI/package prerequisites and native profile mutations. [Destination](adr/004-native-integration-policy.md). |
| 887:7–887:89 | `72a0bc82f8ed4878a93a189268bad4a71d43aa0086efe9ae67a734f9e122abc5` | 1 | ADR | Desktop ownership excludes CLI/package prerequisites and native profile mutations. [Destination](adr/004-native-integration-policy.md). |
| 939:3–939:79 | `d6f55b9dc42a91433312ff1e38fccfb651c5a91988657ec33c84e7929b87b729` | 1 | Issue draft | Lazy import works around a host-command cycle rather than isolating shared pins. [Destination](issue-drafts/stabilize-host-adapters.md). |
| 940:3–940:46 | `dba11394d2c7cc228ebbeceec0cffe8c6be2a006e543036c0b9d3bcfed4994c5` | 1 | Issue draft | Lazy import works around a host-command cycle rather than isolating shared pins. [Destination](issue-drafts/stabilize-host-adapters.md). |
| 950:3–950:80 | `26405f7973a759895e8d88972b0f6a79932fe270a0d661d6a998927b6465f050` | 1 | ADR | Removal and recovery must function without the personal checkout. [Destination](adr/003-runtime-and-worktree-safety.md). |

### `lib/mcp-credentials.mjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/lib/mcp-credentials.mjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 1:1–10:4 | `1e80a26420148234d8482e030f505206fa8cc913c923dbc82ba4091322b60f40` | 1 | ADR | Detect credentials conservatively across transport forms without copying or reporting matched secrets. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 28:1–28:65 | `2dbb0dfc3be13c01f9e8ab93bb8ff172277db25116e839f2c768c4d038bc172d` | 1 | Delete | The predicate or value-producing helper name and its small implementation express this shape directly. |
| 34:1–34:66 | `ad9dc5a86022384fa3aa1b6373881665838301ed54a22a7a72cd4bd811a3cbda` | 1 | Delete | The predicate or value-producing helper name and its small implementation express this shape directly. |
| 40:1–40:81 | `f687e7cce1e67a9f9132e7f5329fd5f469d3845d48a64d0e0f5a5d5f135f5aef` | 1 | Delete | The predicate or value-producing helper name and its small implementation express this shape directly. |
| 45:1–45:81 | `09298afd532e6f9163e875bb86c6747bcb886a2bbd34e25b31cd7b40d95a3153` | 1 | Delete | The predicate or value-producing helper name and its small implementation express this shape directly. |
| 50:1–50:76 | `f1a43535aa59ee5476f6d19f810f85243e9f2804c3dd0bed498023c69a28e8ff` | 1 | Delete | The predicate or value-producing helper name and its small implementation express this shape directly. |
| 71:1–74:4 | `e4bda82b053db5646a3a3451ea59d3452cf17003e37c9f3a6ee1f8fb40cea9f5` | 1 | ADR | Detect credentials conservatively across transport forms without copying or reporting matched secrets. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 88:1–88:73 | `d4ac9bb3e4ed5f9cbba63f4050b21e50b58c22f640d91b9efbe90b99f20a6ec1` | 1 | Delete | The predicate or value-producing helper name and its small implementation express this shape directly. |
| 97:1–100:4 | `866146e89c295acd792b2e19ab9b92dc3d6bacd6d78bb3d401739161d7084909` | 1 | ADR | Detect credentials conservatively across transport forms without copying or reporting matched secrets. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 124:1–128:4 | `428d19222df75f905386058489c22320edc1b310de162838f90be92c457ab39f` | 1 | ADR | Detect credentials conservatively across transport forms without copying or reporting matched secrets. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 131:3–131:78 | `693da8654b708f63b059594e61bd5612320e0aebfa7a40ac91388b8ab66402e4` | 1 | ADR | Detect credentials conservatively across transport forms without copying or reporting matched secrets. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 146:5–146:71 | `d1e80da5e643c57ccd7e57225bcc5957bd0fac679fa6671a9cb77449987bc3e2` | 1 | ADR | Detect credentials conservatively across transport forms without copying or reporting matched secrets. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 160:3–160:74 | `4d6c73c85cb608e6d0a51e79b005987c756f6b64017a055f940973201cc145d2` | 1 | ADR | Detect credentials conservatively across transport forms without copying or reporting matched secrets. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 164:1–167:4 | `58d7e1ee65cc480d39b80c2dbb237c552be8b8eb3159598d69c9ef4eb7fa307f` | 1 | ADR | Detect credentials conservatively across transport forms without copying or reporting matched secrets. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 193:1–193:78 | `5b5acedd71e8a07ce98eceef00d3a624bd8387d8788c29b7394a76ec34b04521` | 1 | Delete | The predicate or value-producing helper name and its small implementation express this shape directly. |
| 224:1–229:4 | `c47cddc6af8142dd2e921da970238bf411a8e28475721c34ba4befed5efe993f` | 1 | ADR | Detect credentials conservatively across transport forms without copying or reporting matched secrets. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 273:1–276:4 | `9c2b99d671b82db78b6e053e195b557dac50d96a9b3d0920555cbe075e9314d5` | 1 | ADR | Detect credentials conservatively across transport forms without copying or reporting matched secrets. [Destination](adr/002-mcp-portability-and-ownership.md). |

### `lib/mcp-sync.mjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/lib/mcp-sync.mjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 18:1–18:69 | `978d964a4087732a4a64b26e210bae7d15a7b99f6fac8a4fcae3eff6738d9765` | 1 | ADR | Preserve inert dialect, overlay order and per-row credential reference expansion. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 24:1–24:67 | `c81769f55b71bd8aa9ca665e2043f4bbe31722f46e14d63cc292165c3a65395d` | 1 | Delete | The helper names and adjacent mapping/guards describe the mechanics. |
| 72:1–72:84 | `738279e16c1e1dedb06e99cb8015f4cc4c3f5f95639a7346a99a46b27aa98675` | 1 | Delete | The helper names and adjacent mapping/guards describe the mechanics. |
| 81:1–81:70 | `15479d75aebe3809d1966436c8b653b0131eb4021e5be603830adae81ec608ba` | 1 | Delete | The helper names and adjacent mapping/guards describe the mechanics. |
| 94:1–97:4 | `c7c9c7b7a797d9460a82d3f13daef036867153836998d31b1340f836398000f0` | 1 | ADR | Preserve inert dialect, overlay order and per-row credential reference expansion. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 114:1–121:4 | `c624ef16964af285caf241cf69eab0ec206d08d4c6915ad591d6bc4ec7fcabac` | 1 | ADR | Preserve inert dialect, overlay order and per-row credential reference expansion. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 127:5–127:81 | `b16f3c25a5745299ee1a61f6a953b2a7666e76998a4793754d339465e030d4af` | 1 | ADR | Preserve inert dialect, overlay order and per-row credential reference expansion. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 128:5–128:57 | `4d2f7ed8a3642cd1240a9907d87c22cbe9a3b4f28412b4412594e243484f9d50` | 1 | ADR | Preserve inert dialect, overlay order and per-row credential reference expansion. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 179:1–184:4 | `344ff293fe5c0a2bc2919e1166e72e53ca9900b3d15e9e421a91406fbca714be` | 1 | ADR | Preserve inert dialect, overlay order and per-row credential reference expansion. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 228:1–231:4 | `f895183ee1d7de3a0c03ca48efbc9cc499ea4ffc6014a6cdace5940a7320ffd2` | 1 | ADR | Foreign rows, declarations and patch trivia survive a surgical owned-row update. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 249:1–249:89 | `1ec06ef8b79a0db066a1f723755f90a6b86bc383b697b16eefab7e7336df3e1f` | 1 | ADR | Foreign rows, declarations and patch trivia survive a surgical owned-row update. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 277:1–277:73 | `976b9a6d02c5e9bb1441911bbe3d705fa1a97be349b35f777ba244dafd0c1599` | 1 | ADR | Foreign rows, declarations and patch trivia survive a surgical owned-row update. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 280:3–280:81 | `b124cb15299b86481c754d93bc4d694639728b5464e0aa1ab139eaae34baa5d1` | 1 | ADR | Foreign rows, declarations and patch trivia survive a surgical owned-row update. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 300:1–304:4 | `66c840b5d35ea1d090e3e6ff37056c0640421a641abe74ae756443326a9762db` | 1 | ADR | Foreign rows, declarations and patch trivia survive a surgical owned-row update. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 321:1–321:76 | `72d1d6ee285200868d8482b8ef41619576252c0d5fadb32ef56165590897caa6` | 1 | Delete | `validatePatch` and its structural branches already identify rejection conditions. |
| 348:1–352:4 | `db45dcf0a4fefa9139b933ee960ad8c97b4680f6ac9d17a3d3cc1c9107019a3a` | 1 | ADR | Foreign rows, declarations and patch trivia survive a surgical owned-row update. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 367:7–367:90 | `b2fe9e71ddf5f0c87c030d236d5c3f8e7fce4a1217fd600ec0f3ae465873f91b` | 1 | ADR | Foreign rows, declarations and patch trivia survive a surgical owned-row update. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 420:1–420:75 | `59277c56cdec8258406ff51eb7303c1357ea949b18e6c1794cafa9b03a9cf902` | 1 | Delete | Sync/removal entry point names and inputs already define their run modes. |
| 467:1–467:87 | `efa4dde18fb0a9e11243d2ebc8bb94a9d0370a72099ff5c6a49e4f234f1c1433` | 1 | Delete | Sync/removal entry point names and inputs already define their run modes. |

### `lib/parity.mjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/lib/parity.mjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 6:1–6:79 | `de727bfe3162e73b307ba56641e63218032b0ad8604b736d5e1dae1d9a458049` | 1 | Issue draft | Native-output-shaped regex does not model the full set of valid host declarations. [Destination](issue-drafts/stabilize-host-adapters.md). |
| 7:1–7:49 | `688ff1ecc954ff3f8dd6dcea84e695afb792759308e261f149ae36eeaf91d201` | 1 | Issue draft | Native-output-shaped regex does not model the full set of valid host declarations. [Destination](issue-drafts/stabilize-host-adapters.md). |
| 37:1–37:71 | `9342acede4cef81b00a35e7db1c0e6b643d3c8f662bd0faaaa4bcd5be5eb8a88` | 1 | Issue draft | The status report should distinguish parsed declarations from evidence of native loaded servers. [Destination](issue-drafts/stabilize-host-adapters.md). |
| 43:5–43:80 | `4798c2f316577b9855bc92526fefa80cfd43b498f6d187f4af018d8bccc937d2` | 1 | ADR | Desktop deliberately receives no Kitto MCP rows. [Destination](adr/002-mcp-portability-and-ownership.md). |

### `lib/pi_config.py`

Parser: `Python` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/lib/pi_config.py)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 1:1–1:23 | `381f9bfc69d49d39040a7d5fc3197ce385019a2ba2de649622f841a8c658ed37` | 1 | Keep | First-line executable dispatch selects Python 3; semantic shebang. |
| 27:1–27:80 | `55ab27c4409afd2bfaf68ae1ddcc43671a09fbcf2722bacc3837bd675ef8c9a4` | 1 | ADR | Compose/export must share one explicit boundary and refuse truncated shared text. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 28:1–28:78 | `8e0dd889468b6737be76ac267e4fd9ce352455182f6a3f01e8a65e0e48046c6b` | 1 | ADR | Compose/export must share one explicit boundary and refuse truncated shared text. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 29:1–29:79 | `38e833407c34adff03aada4d22b2d34274d96320529f2ad0cf1bf84b8dbe647a` | 1 | ADR | Compose/export must share one explicit boundary and refuse truncated shared text. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 30:1–30:54 | `3a41e7d7fe8787aa6d8ad5e03ae41ad0e57ff56317f4d280f3a1e8bd7fae577c` | 1 | ADR | Compose/export must share one explicit boundary and refuse truncated shared text. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 33:1–33:80 | `9068f2198e1594072fcf207adc77393afff0fdb7037ec8eeff52f252aeddb7f4` | 1 | ADR | Pi export must reject local secret shapes consistently with cross-host import. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 34:1–34:81 | `905a01526dde53a76a1d42ce1b245c342bd821147a88bacc4a499ab55ebddbc4` | 1 | ADR | Pi export must reject local secret shapes consistently with cross-host import. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 94:1–94:75 | `e2c818cdb520c539561cc789eaba1125b26dd4b9af09b0fce56688f5b6527f39` | 1 | Delete | Decorative dividers do not carry a behavior contract. |
| 225:1–225:76 | `29b329ede342123e830ecf3ee54518e9eddaeead96b5fa97e8c92ba7de7165a4` | 1 | Delete | Decorative dividers do not carry a behavior contract. |
| 261:5–261:79 | `b36e97eef39a66bb2bd4772f1537bbfba9b744f3932848ab69620e6bf1157367` | 1 | ADR | Retain local/runtime state, object package entries, and stable shared export order. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 262:5–262:82 | `7edf6af369321663685c89dd14803b2f8e491fe7d26538cf56f305e0f063d67a` | 1 | ADR | Retain local/runtime state, object package entries, and stable shared export order. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 269:5–269:81 | `65c6efbe3fc2acac110bbfff7c3024927837deeb234e63c37c598fc0c67cea36` | 1 | ADR | Retain local/runtime state, object package entries, and stable shared export order. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 270:5–270:69 | `5b4bb54a3946bed445152db8995b0bdff1eeb0cb3a26a2bf49e467d576b3e530` | 1 | ADR | Retain local/runtime state, object package entries, and stable shared export order. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 303:5–303:81 | `bda4d17bc908ef5cfbe3eabba145c970468df3752d9e902d4c6ee8bd21256b81` | 1 | ADR | Retain local/runtime state, object package entries, and stable shared export order. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 304:5–304:66 | `87ac1b96d49a55346294a69510821ab0a80a950bcf6e3d0bfe4796180a6326a5` | 1 | ADR | Retain local/runtime state, object package entries, and stable shared export order. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 333:5–333:79 | `fbbadcb1ab471ef57233b0a100bc4308a37923c960db56210db25e22c4a806f8` | 1 | ADR | Retain local/runtime state, object package entries, and stable shared export order. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 334:5–334:62 | `55dd44836a3c31f89bb61e3456a280d601a19b1b50a4acb2cc2ce95ddb60fdec` | 1 | ADR | Retain local/runtime state, object package entries, and stable shared export order. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 414:45–414:84 | `3bd229e8fbc7dc9f34c4350e1199e688ac2b48b548e1d7791922f53c7703efd9` | 1 | ADR | Do not export machine-specific, platform-only or unmanaged servers as shared declarations. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 417:45–417:79 | `e37facb70330ab743404dcdd4018c10da537679da1fef5516db922f0835a4aef` | 1 | ADR | Do not export machine-specific, platform-only or unmanaged servers as shared declarations. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 422:45–422:75 | `76636f6186190c09c0ee6cd484d2417fa90d903215c0f628f0b010d298c8f619` | 1 | ADR | Do not export machine-specific, platform-only or unmanaged servers as shared declarations. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 475:5–475:80 | `2987b52088a4e760b673f7b5c5274fed051261fbf1bc7c0def30329b5ce93222` | 1 | ADR | Compose/export must share one explicit boundary and refuse truncated shared text. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 476:5–476:65 | `781fdc6839a8a6da8494733dc7853a480bbe4f66df49d58ad503801b849b9cdf` | 1 | ADR | Compose/export must share one explicit boundary and refuse truncated shared text. [Destination](adr/001-configuration-and-host-boundaries.md). |

### `lib/scope-service.mjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/lib/scope-service.mjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 99:9–99:89 | `71fb396ab14002adcd31684b9d6d96890bead150a7d21007ad7dbe9584830dfe` | 1 | ADR | Account and staging ownership, plus concurrent directory creation, are part of the service contract. [Destination](adr/004-native-integration-policy.md). |
| 133:1–133:77 | `7fae4407096ccadbc2f3579c3f3398a68a88b6a610596cafaeff883d5d69e249` | 1 | ADR | Account and staging ownership, plus concurrent directory creation, are part of the service contract. [Destination](adr/004-native-integration-policy.md). |
| 231:5–231:85 | `5f994b5122b50735b8d07e53515c56ef08911a8be5c3b51a95dcc7a2b3d19603` | 1 | ADR | Account and staging ownership, plus concurrent directory creation, are part of the service contract. [Destination](adr/004-native-integration-policy.md). |
| 232:5–232:78 | `8498276f479a286d39bf7929ae6d0a740336f2c0c128ad9aeeff8d107ff3bd47` | 1 | ADR | Account and staging ownership, plus concurrent directory creation, are part of the service contract. [Destination](adr/004-native-integration-policy.md). |

### `lib/scope-setup.mjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/lib/scope-setup.mjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 89:5–89:81 | `7322b61b9c792602f60d98502e6dffd9d49ff362e375c059519542a003f3236a` | 1 | ADR | Desktop is excluded without blocking other hosts. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 138:7–138:77 | `62f833ffc3815760724141acc5c8ceba4970212813c64ebdff8a4e97a2cb3523` | 1 | ADR | Shared files are created by the service account that will use them. [Destination](adr/004-native-integration-policy.md). |

### `lib/scopes.mjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/lib/scopes.mjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 12:3–12:78 | `4125f68d6c6ed90c5512776bdf0d5c8d458840c2b05577efa714174208e9e36f` | 1 | ADR | Native launches cannot depend on the setup-shell environment. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 48:1–48:81 | `919e11a1618d3089f6c5541353829f4dcf6b406fda2d85901de2a8300a999578` | 1 | Delete | The registry read/merge and atomic write make its field preservation visible. |

### `lib/update-notice.mjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/lib/update-notice.mjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 11:1–11:85 | `bd4b8ecc3dae39e26ecb60113208b0c119b5c407f0bb96d793b8fcba3b854130` | 1 | ADR | Keep the daily self-check silent on failure and nonblocking for agent startup. [Destination](adr/004-native-integration-policy.md). |
| 12:1–12:84 | `0db989d6124756f6143eea464aa260f7eacf557ab2dab8816e98d6c05a6afd19` | 1 | ADR | Keep the daily self-check silent on failure and nonblocking for agent startup. [Destination](adr/004-native-integration-policy.md). |
| 25:13–25:81 | `4ca838d5967160bfa313c37017dbfc3a9a36923807faae327e3b683ccbf34072` | 1 | ADR | Keep the daily self-check silent on failure and nonblocking for agent startup. [Destination](adr/004-native-integration-policy.md). |

### `lib/worktree-audit.mjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/lib/worktree-audit.mjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 7:1–7:83 | `cd659b43a54e3c555849fd803d28419dd18303752e3318eb2188f071d99ffa30` | 1 | ADR | Preserve local read-only evidence, path bytes and conservative checks rather than treating unknown as clean. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 20:3–20:91 | `2d017f67ad7c22e1a95c9b489a9c4208ec43cf72aeba90c1885824d5a3ff30b8` | 1 | ADR | Preserve local read-only evidence, path bytes and conservative checks rather than treating unknown as clean. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 28:57–28:89 | `e535eb87bf3873bc145622ecee476c886d89a7c088d26842f7cea5812eb3a88d` | 1 | ADR | Preserve local read-only evidence, path bytes and conservative checks rather than treating unknown as clean. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 44:3–44:80 | `5b6d5dd3e5a35161056c8d1c8f034ccbb27872e1ce63df7504615c8f838598b6` | 1 | ADR | Preserve local read-only evidence, path bytes and conservative checks rather than treating unknown as clean. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 53:3–53:81 | `6567747d52b878c7744c64f7beebdc57d238ca25bf61705813d140728a51ca81` | 1 | ADR | Preserve local read-only evidence, path bytes and conservative checks rather than treating unknown as clean. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 54:3–54:71 | `0f246fda94d0e8ab21e4ca87bf79766d12da0d0fbd2c53893d8a0907cbf6b166` | 1 | ADR | Preserve local read-only evidence, path bytes and conservative checks rather than treating unknown as clean. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 77:5–77:80 | `211b21ba2fc20adf874ac87ee63a68cc6ffab825c206782d6a9f9c5ea268e7ae` | 1 | ADR | Preserve local read-only evidence, path bytes and conservative checks rather than treating unknown as clean. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 78:5–78:86 | `a701387bd1a9a98cef8c4bff6f3750bd5c22a0982fa7e770e156c23abdaffdaa` | 1 | ADR | Preserve local read-only evidence, path bytes and conservative checks rather than treating unknown as clean. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 115:3–115:81 | `be4e08f3e1d8471c8aacafc5be4636f8880f21cfdffb0052d9711f532e8f1132` | 1 | ADR | Preserve local read-only evidence, path bytes and conservative checks rather than treating unknown as clean. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 116:3–116:84 | `9636e3230b367960c14fc8a96133a908920f41a66183d74ebf590a089499e887` | 1 | ADR | Preserve local read-only evidence, path bytes and conservative checks rather than treating unknown as clean. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 154:1–154:88 | `b8c8fd49dce95e5182203c616884649f9a24030ff2f37f3e2b5a11b7077da556` | 1 | Delete | The exported audit function name and report construction already state its purpose. |

### `lib/worktree-lifecycle.mjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/lib/worktree-lifecycle.mjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 161:1–161:77 | `513a8d67df16a5abfc987670fb03e0f81beca1fafc3160f58e5526bf4711a77f` | 1 | ADR | Positive claim/registration and raw disk evidence govern worktree operations; hints are private and non-authoritative. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 162:1–162:82 | `70c5f79cd0b2d33604c9c42064a8f8ef875f1bf35a43c4dfdb418d4f995fb29d` | 1 | ADR | Positive claim/registration and raw disk evidence govern worktree operations; hints are private and non-authoritative. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 163:1–163:81 | `b2016a13b5fef9b37ee20e39c24987be292bf2eed82118e5137ab86737db572c` | 1 | ADR | Positive claim/registration and raw disk evidence govern worktree operations; hints are private and non-authoritative. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 205:5–205:95 | `0f821275e6263ed2c498ab48b6811d3f4699f3d1d7b590ddfba2f867bc581e54` | 1 | ADR | Positive claim/registration and raw disk evidence govern worktree operations; hints are private and non-authoritative. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 211:5–211:75 | `5666295c81db5ebc0d1f8fcfffa0b3e16a146a50866e09d269ef0723e67524d8` | 1 | ADR | Positive claim/registration and raw disk evidence govern worktree operations; hints are private and non-authoritative. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 281:1–281:83 | `cc1cdecd1a822e05594191b47508b5bc02e41bfa20164cf3ebfcf709c0bdc02f` | 1 | ADR | Positive claim/registration and raw disk evidence govern worktree operations; hints are private and non-authoritative. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 282:1–282:84 | `95f7c0a13521889e2b8820ddf171d0e81223053cadada653de5d2c5333c633f9` | 1 | ADR | Positive claim/registration and raw disk evidence govern worktree operations; hints are private and non-authoritative. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 285:5–285:67 | `01a9d622d1ba67fe26050bdb56edfe8d00f195ad6ecd804a6e5d126be8dc3060` | 1 | ADR | Positive claim/registration and raw disk evidence govern worktree operations; hints are private and non-authoritative. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 418:1–418:87 | `e7a41d6fc1389590ab50a6588a350054d22cf0d110478d0a9a747b0bafbc0a08` | 1 | ADR | Positive claim/registration and raw disk evidence govern worktree operations; hints are private and non-authoritative. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 447:3–447:80 | `ae0797da04565908d34bd1380896dc618f646f61a3678e1d5edafd000df13ef8` | 1 | ADR | Positive claim/registration and raw disk evidence govern worktree operations; hints are private and non-authoritative. [Destination](adr/003-runtime-and-worktree-safety.md). |

### `setup.sh`

Parser: `Bash` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/setup.sh)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 1:1–1:20 | `e2b37d0fbeebd5358ba88a5ef5469cfab940c91f397b72b95107b9b6515a9ece` | 1 | Keep | First-line executable dispatch selects Bash; semantic shebang. |
| 2:1–2:66 | `6545109fcc1c5aea94b910043fed7098878939ef0422583fb243cab4bac5742c` | 1 | ADR | Document compatibility and a single public setup boundary; retain the Bash 3.2 and noninteractive-legacy branches. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 3:1–3:67 | `ce466ef4de3c4697703ab90451295fdc580e8dac3118269dc8f977b1c20ddb3c` | 1 | ADR | Document compatibility and a single public setup boundary; retain the Bash 3.2 and noninteractive-legacy branches. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 37:1–37:81 | `2578f09967861d69db15da60004ac2b6583ed11c3a69bf1a8341e1ba38d3bcf9` | 1 | ADR | Document compatibility and a single public setup boundary; retain the Bash 3.2 and noninteractive-legacy branches. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 38:1–38:72 | `87b02052dbfbb4898a6439e376f512e7f288a3b707026f61f0e3a60c1e3760d9` | 1 | ADR | Document compatibility and a single public setup boundary; retain the Bash 3.2 and noninteractive-legacy branches. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 50:1–50:79 | `5088732a9006bb2ca77d94b2683033bfc1b7a3ea1c417e702d26de16c2f5235a` | 1 | ADR | Document compatibility and a single public setup boundary; retain the Bash 3.2 and noninteractive-legacy branches. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 60:1–60:69 | `2856591a751150963f6bb05fd30ff6808abc5821b0c067d75c6b068a5cf418ce` | 1 | ADR | Document compatibility and a single public setup boundary; retain the Bash 3.2 and noninteractive-legacy branches. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 74:1–74:68 | `aeaa388227bbdc553f7ce74f89724150ebc1f099b0e5fe9d292948073be93366` | 1 | ADR | Document compatibility and a single public setup boundary; retain the Bash 3.2 and noninteractive-legacy branches. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 77:9–77:81 | `de0e3360fb09b44099d639ae01840ea454f507fb9cb2b983f2cb9ffa0e3ceb9a` | 1 | ADR | Document compatibility and a single public setup boundary; retain the Bash 3.2 and noninteractive-legacy branches. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 78:9–78:79 | `589f18307eac81c2ae292f01a20f16432fe39e3ee0e2d95afb55eee88cc16264` | 1 | ADR | Document compatibility and a single public setup boundary; retain the Bash 3.2 and noninteractive-legacy branches. [Destination](adr/001-configuration-and-host-boundaries.md). |

### `skills/context-budget/scripts/dsh-usage.mjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/skills/context-budget/scripts/dsh-usage.mjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 1:1–1:20 | `4949218de757741f2174599ad06408d4f369e2da90bbe7f4b32313bd792d7393` | 1 | Keep | First-line executable dispatch selects Node.js; semantic shebang. |
| 2:1–2:86 | `5a21415cb210f7bda8ed62cb7a0620931ea3525aaddefda3250c59c74f64a3eb` | 1 | Delete | The skill already documents the read-only result and report dimensions. |
| 3:1–3:82 | `cb0409e96682534321ce9e390fb74a021516783e811142e403d6b56f6c89159c` | 1 | ADR | Preserve the session log and usage-event source of truth alongside verification guidance. [Destination](adr/005-dsh-compaction-budget.md). |
| 4:1–4:65 | `df7020aceefdc2cfb05ba839af16d750faeb7b245f990bf579a488264ec98786` | 1 | ADR | Preserve the session log and usage-event source of truth alongside verification guidance. [Destination](adr/005-dsh-compaction-budget.md). |
| 123:17–123:55 | `863aa402e63f2aaa9b3955a2b3da80258710c5b8132bdbcc688411b2336059b9` | 1 | Issue draft | Catch treats any selected JSON failure like a partial write; distinguish incomplete totals. [Destination](issue-drafts/report-partial-dsh-usage.md). |

### `skills/diagnose/scripts/hitl-loop.template.sh`

Parser: `Bash` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/skills/diagnose/scripts/hitl-loop.template.sh)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 1:1–1:20 | `e2b37d0fbeebd5358ba88a5ef5469cfab940c91f397b72b95107b9b6515a9ece` | 1 | Keep | First-line executable dispatch selects Bash; semantic shebang. |
| 2:1–2:39 | `e98189a92abc5c5c8280ff9975c7ee56ff8dfba695c9529a3e9f4ede6f152def` | 1 | Delete | Section headings and invocation restate the template name or shell interpreter. |
| 3:1–3:52 | `f4d206c7fe1e0cf87f525cf175b866150a74472cbc6045d0faefea5b8cc83d81` | 1 | Delete | Tell the agent to copy the template before changing it in the [distributed skill](../skills/diagnose/SKILL.md). |
| 4:1–4:73 | `e24b59f079fcaca9292533a9f854cc5201b480bec829a072bda13d2390e1a92d` | 1 | Delete | Assign distinct agent and human terminal roles in the [distributed skill](../skills/diagnose/SKILL.md). |
| 5:1–5:2 | `334359b90efed75da5f0ada1d5e6b256f4a6bd0aee7eb39c0f90182a021ffc8b` | 1 | Delete | Decorative comment-only spacing. |
| 6:1–6:9 | `71c969f874afd4e5ea8fb16e708c1a09337a4985b1905148d0704537419fe29f` | 1 | Delete | Section headings and invocation restate the template name or shell interpreter. |
| 7:1–7:31 | `a4ee5deb8e3f7d55fad68a4ed7933d28588e4a70e938be49596b7fb8c2cd7e89` | 1 | Delete | Section headings and invocation restate the template name or shell interpreter. |
| 8:1–8:2 | `334359b90efed75da5f0ada1d5e6b256f4a6bd0aee7eb39c0f90182a021ffc8b` | 2 | Delete | Decorative comment-only spacing. |
| 9:1–9:15 | `f2eb4b387a73271a1efa4dae6dcc3371f7c770fe5726874d399c7a0bf31532ea` | 1 | Delete | Section headings and invocation restate the template name or shell interpreter. |
| 10:1–10:69 | `4b02967bc0e14fe2ed573c91528aaa5ff053aa14892e381c608e0e9e8fc11d32` | 1 | Delete | `step` and `capture` function bodies immediately show argument and terminal behavior. |
| 11:1–11:74 | `ba425048c30169e383e8e28bd29fa84fe57a81f5e2b7745fd2783f60cb5b13a5` | 1 | Delete | `step` and `capture` function bodies immediately show argument and terminal behavior. |
| 12:1–12:2 | `334359b90efed75da5f0ada1d5e6b256f4a6bd0aee7eb39c0f90182a021ffc8b` | 3 | Delete | Decorative comment-only spacing. |
| 13:1–13:79 | `6e865c1a92ba33efce1d9333938b2109eae60ec2588f2a3c2c059221c679de58` | 1 | Delete | Final `printf` statements explicitly show machine-readable `KEY=VALUE` output. |
| 29:1–29:75 | `0bbad2ffc9767017e867a0765e454010567a1dbc8115ece0046b476c21c8f952` | 1 | Delete | Describe where the sample `step` and `capture` calls begin in the [distributed skill](../skills/diagnose/SKILL.md). |
| 37:1–37:75 | `f1c711d534ea810b432b7080e22b0919d95b2851a4c7a5e1d0e6a49b72be27d3` | 1 | Delete | Describe where editable prompts end and the fixed reporting block begins in the [distributed skill](../skills/diagnose/SKILL.md). |

### `skills/jev-decide/scripts/jev.mjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/skills/jev-decide/scripts/jev.mjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 1:1–1:20 | `4949218de757741f2174599ad06408d4f369e2da90bbe7f4b32313bd792d7393` | 1 | Keep | First-line executable dispatch selects Node.js; semantic shebang. |
| 2:1–2:81 | `d89393bd16cd5611bf8df50aa2b72e06998eaf962da4cbc9beafedda4314d315` | 1 | Delete | The usage text and skill explain typed questions, scope, and output. |
| 3:1–3:77 | `4177d0879bdff73a11c6b79839c674032aef747777f4f485ff5338e4b3c213d7` | 1 | Delete | The usage text and skill explain typed questions, scope, and output. |
| 4:1–4:3 | `a2c2339691fc48fbd14fb307292dff3e21222712d9240810742d7df0c6d74dfb` | 1 | Delete | Decorative comment separators. |
| 5:1–5:58 | `74783c0b10515774154a544b80b9f0ecc994177a60b0afabc50ee213afba95eb` | 1 | Delete | File input is documented in skill/CLI usage; explicit `@file` avoids bare path ambiguity. |
| 6:1–6:100 | `930567c1c52a1ec91e4e0a2871e4e240f372480e567c3abf58e89c5dca1bd3e3` | 1 | Delete | The skill already gives a working inline example; CLI usage describes input shapes. |
| 7:1–7:78 | `8a8c2d5569de5853576bc3cab7da7675b5d9250e776a50b36b2403d7ac0a9627` | 1 | Issue draft | Two sequential `@-` reads cannot retrieve independent inputs from one EOF-delimited stream. [Destination](issue-drafts/validate-jev-input-sources.md). |
| 8:1–8:3 | `a2c2339691fc48fbd14fb307292dff3e21222712d9240810742d7df0c6d74dfb` | 2 | Delete | Decorative comment separators. |
| 9:1–9:74 | `75c71b9b3dc2d7120a33e5101a5acf2c4584648987635b578477d018a5406f41` | 1 | Delete | Credential names and Go vs. Console billing are described in the distributed skill and the fallback error. |
| 10:1–10:79 | `4c00358a0d32ee06e8db84a4fd4ee1ebfe376ec5acf7af20690e793bc073db6f` | 1 | Delete | Credential names and Go vs. Console billing are described in the distributed skill and the fallback error. |
| 11:1–11:78 | `8c136cdecb56baff30fdaf6e1b8ad75cfc90e64ea36c9f9b7b6596889c1063d8` | 1 | Delete | Credential names and Go vs. Console billing are described in the distributed skill and the fallback error. |
| 12:1–12:91 | `f7d383ba81c28dd9fa6c18afac38351143f8137d30394c4f708fd09fa1b6d64d` | 1 | Delete | Credential names and Go vs. Console billing are described in the distributed skill and the fallback error. |
| 13:1–13:37 | `abad2051f699828a1f911414af10f60357c6cae9b59be3a68baf93720008a50c` | 1 | Delete | Credential names and Go vs. Console billing are described in the distributed skill and the fallback error. |
| 63:1–63:81 | `323e7a108709613679761545004dbf1f9f471adbfc54ab3603b3f1261bb61e46` | 1 | Issue draft | Ad-hoc DSH refs parsing depends on internal storage shape. [Destination](issue-drafts/validate-jev-input-sources.md). |
| 93:1–93:93 | `735773836da4997c0ba4a82e2e1729dc331c85bd14fe145f9ee1dfce8f2cd73c` | 1 | Delete | Credential names and Go vs. Console billing are described in the distributed skill and the fallback error. |
| 100:5–100:84 | `76100b6ebe6366d9b3569bf288085bc00e7fa951d42c0086a1d4cc77cd0da015` | 1 | Delete | The distributed skill already records the product User-Agent requirement and diagnostic. |

### `sync.sh`

Parser: `Bash` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/sync.sh)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 1:1–1:20 | `e2b37d0fbeebd5358ba88a5ef5469cfab940c91f397b72b95107b9b6515a9ece` | 1 | Keep | First-line executable dispatch selects Bash; semantic shebang. |
| 2:1–2:63 | `fe2c146d0ebddf22ef4b131fe30691fb00e60719d74de45b607781edb70b4159` | 1 | ADR | First exact line of `--help` payload; its leading banner is printed. Preserved as literal CLI output, not a comment. [ADR 001](adr/001-configuration-and-host-boundaries.md). |
| 3:1–3:40 | `2dae4542e4df70d64d661ab33e923c6323fa5bdc649d64f249d6d5c4d6e80578` | 1 | ADR | `--help` prints the Pi adapter role/title. Preserved as literal CLI output, not a comment. [ADR 001](adr/001-configuration-and-host-boundaries.md). |
| 4:1–4:2 | `334359b90efed75da5f0ada1d5e6b256f4a6bd0aee7eb39c0f90182a021ffc8b` | 1 | ADR | `--help` prints this separator between heading and usage. Preserved as literal CLI output, not a comment. [ADR 001](adr/001-configuration-and-host-boundaries.md). |
| 5:1–5:51 | `21bb12adda06990eb0c1ce5c8572712ae6b21a23d16a4125ced085e30d812583` | 1 | ADR | `--help` tells operators JS is the public entry point. Preserved as literal CLI output, not a comment. [ADR 001](adr/001-configuration-and-host-boundaries.md). |
| 6:1–6:56 | `e22a62c632bcb0bd0a21ce6fcce3396b0d746461999269c4c8ca56ff6a2b5b85` | 1 | ADR | `--help` shows the direct entry's deprecation and replacement. Preserved as literal CLI output, not a comment. [ADR 001](adr/001-configuration-and-host-boundaries.md). |
| 7:1–7:33 | `d50ee3429e413efd4d81985a4d4fd3686c29b4aa5d12d9defd00b3fe258d180d` | 1 | ADR | `--help` gives the maintenance-skill alternative. Preserved as literal CLI output, not a comment. [ADR 001](adr/001-configuration-and-host-boundaries.md). |
| 8:1–8:2 | `334359b90efed75da5f0ada1d5e6b256f4a6bd0aee7eb39c0f90182a021ffc8b` | 2 | ADR | `--help` prints this separator before the legacy commands. Preserved as literal CLI output, not a comment. [ADR 001](adr/001-configuration-and-host-boundaries.md). |
| 9:1–9:59 | `c6a47ebb453d896d1fd44e51512829c8a8a985e595e62ab6d144f92f905783d5` | 1 | ADR | `--help` names the compatible command scope. Preserved as literal CLI output, not a comment. [ADR 001](adr/001-configuration-and-host-boundaries.md). |
| 10:1–10:47 | `edd66fce3fa65c4689eed02e21cb051515fa0b2fdb0c1dab48c6944320ae489e` | 1 | ADR | `--help` documents read-only `status`. Preserved as literal CLI output, not a comment. [ADR 001](adr/001-configuration-and-host-boundaries.md). |
| 11:1–11:72 | `021fb6fd24414cb5e482e9555cc0cf2a8fed7b01e22c74a8e52e9a2802163fbc` | 1 | ADR | `--help` documents the `pull` direction and structured merges. Preserved as literal CLI output, not a comment. [ADR 001](adr/001-configuration-and-host-boundaries.md). |
| 12:1–12:60 | `52911710e6a64e96834ad78c3421ebbbc73803d4901e9a9f6a3532ee6cfc5393` | 1 | ADR | `--help` documents `push` direction and privacy boundary. Preserved as literal CLI output, not a comment. [ADR 001](adr/001-configuration-and-host-boundaries.md). |
| 13:1–13:64 | `5c10049bb9d9e9c5b9d037f00f247073b83990312936ba8542d4b305466b50e2` | 1 | ADR | `--help` continues the `push` shared/addendum export description. Preserved as literal CLI output, not a comment. [ADR 001](adr/001-configuration-and-host-boundaries.md). |
| 14:1–14:40 | `06a49fc4f02f9816942ca06ee02991d47e10c317873f5fe8bfe9ecda98b20a24` | 1 | ADR | `--help` documents the `--commit` option for export. Preserved as literal CLI output, not a comment. [ADR 001](adr/001-configuration-and-host-boundaries.md). |
| 15:1–15:71 | `adddafb3d0b7718d2fb3156c893c8b4fa3b02a29e81c0a49e750f4b177510978` | 1 | ADR | `--help` documents `deps` and the platform-specific tool chain. Preserved as literal CLI output, not a comment. [ADR 001](adr/001-configuration-and-host-boundaries.md). |
| 16:1–16:2 | `334359b90efed75da5f0ada1d5e6b256f4a6bd0aee7eb39c0f90182a021ffc8b` | 3 | ADR | `--help` prints this separator before shared-skill ownership. Preserved as literal CLI output, not a comment. [ADR 001](adr/001-configuration-and-host-boundaries.md). |
| 17:1–17:58 | `deff2b93e3b67f4a814b4989362c4bf05d81117eee07310fd3367f9c6217dd55` | 1 | ADR | `--help` names JS shared skill ownership and locking. Preserved as literal CLI output, not a comment. [ADR 001](adr/001-configuration-and-host-boundaries.md). |
| 18:1–18:32 | `dec7bb6e26e0e02a5760465c312c021c5b9d308f801b3907f2e4125acac71c5e` | 1 | ADR | `--help` gives the direct entry opt-in policy. Preserved as literal CLI output, not a comment. [ADR 001](adr/001-configuration-and-host-boundaries.md). |
| 19:1–19:54 | `306ee709fc4eeeca11bbbad87604f18eb0a1480173082cf6505b46f225fe63fb` | 1 | ADR | `--help` prints the exact legacy shared-skill opt-in example. Preserved as literal CLI output, not a comment. [ADR 001](adr/001-configuration-and-host-boundaries.md). |
| 20:1–20:2 | `334359b90efed75da5f0ada1d5e6b256f4a6bd0aee7eb39c0f90182a021ffc8b` | 4 | ADR | `--help` prints this separator before local settings. Preserved as literal CLI output, not a comment. [ADR 001](adr/001-configuration-and-host-boundaries.md). |
| 21:1–21:47 | `977f7276812b7da5d0ad440509ffd69d136806751083aa15870eef1f6cdcd122` | 1 | ADR | `--help` locates ignored machine-owned configuration. Preserved as literal CLI output, not a comment. [ADR 001](adr/001-configuration-and-host-boundaries.md). |
| 22:1–22:33 | `d89b6629ea3da87360150ea10ff1482c105dbec7d6869afb3f66104772c6dffd` | 1 | ADR | `--help` identifies the local package list. Preserved as literal CLI output, not a comment. [ADR 001](adr/001-configuration-and-host-boundaries.md). |
| 23:1–23:41 | `6cfba6cf333bc2c8ddce7bbc209e764629fc92c322e0abb9760fe563ce9a2630` | 1 | ADR | `--help` identifies the local package suppression list. Preserved as literal CLI output, not a comment. [ADR 001](adr/001-configuration-and-host-boundaries.md). |
| 24:1–24:40 | `8e3ce1b413981bb97e7aaa84ff0c75a726e5e117ef2ad8027c83d696bb65e6d7` | 1 | ADR | `--help` identifies the local settings overrides. Preserved as literal CLI output, not a comment. [ADR 001](adr/001-configuration-and-host-boundaries.md). |
| 25:1–25:42 | `751a86b7660a14c302959e1ba578756444eb08c0cb3df22db83ac27f278ffd7d` | 1 | ADR | Last exact line of `--help` payload; describes local MCP overrides. Preserved as literal CLI output, not a comment. [ADR 001](adr/001-configuration-and-host-boundaries.md). |
| 26:1–26:63 | `fe2c146d0ebddf22ef4b131fe30691fb00e60719d74de45b607781edb70b4159` | 2 | Delete | Decorative closing banner is outside the fixed 2–25 help extraction. |
| 62:37–62:67 | `306e192b3d6952626d64115fcf8a5077d2f90c8d4bd80d6d83941cc018ab53d1` | 1 | ADR | Keep legacy flag/ownership, preflight and exact structured comparison behavior documented outside the script. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 68:1–68:77 | `7b3347fd20ab630c05c723a61a8a4a249d1898146200c1b80683099d316f6575` | 1 | ADR | Keep legacy flag/ownership, preflight and exact structured comparison behavior documented outside the script. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 97:15–97:69 | `3827c720cc0b3a4cfff1e733a8cf4b73ccd808c3b7fbebe76a8dd9d3ce2fbd2c` | 1 | Delete | `json_same` and the Python comparison show the equality and exit convention. |
| 110:20–110:41 | `2e17f64f0fdade4b336a66e8bff011b1342b651442b61aff3692000720fdfdf6` | 1 | Delete | The function name and local assignments already express its positional arguments. |
| 118:1–118:75 | `125e8343dc7acd07dc326fff85a990de7358dbb3fb68e6d617521345a6e2da22` | 1 | Delete | Decorative section divider. |
| 120:17–120:38 | `24ad7bd8fe6b43b667d117d06b6e712c5bfc03c5cc57d683c1e70c7248aa1c79` | 1 | Delete | The function name and local assignments already express its positional arguments. |
| 128:22–128:77 | `e286131b41e1508fffc00d3bc064446873fdfe3da6b930fffc19fd2a4ff3a7e1` | 1 | ADR | Keep legacy flag/ownership, preflight and exact structured comparison behavior documented outside the script. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 139:9–139:75 | `f0ecc171126f2701e2062dea69beb815418022928d6b26ed40c175677592135a` | 1 | ADR | Keep legacy flag/ownership, preflight and exact structured comparison behavior documented outside the script. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 140:9–140:73 | `413fd7398a57dc613ec859db4804a0aaa1ad3bea79ef3f506aa0e0934bc50019` | 1 | ADR | Keep legacy flag/ownership, preflight and exact structured comparison behavior documented outside the script. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 146:30–146:85 | `d4303c55636c433c6b4f4cdf9b8fc78d6d98ec6a6085a10c19b9f532da1b0f39` | 1 | ADR | Keep legacy flag/ownership, preflight and exact structured comparison behavior documented outside the script. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 148:9–148:75 | `f0ecc171126f2701e2062dea69beb815418022928d6b26ed40c175677592135a` | 2 | ADR | Keep legacy flag/ownership, preflight and exact structured comparison behavior documented outside the script. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 149:9–149:70 | `eb0802416e84c84005bc3428831d7fe908935ca56ba799f808379f29123e76f4` | 1 | ADR | Keep legacy flag/ownership, preflight and exact structured comparison behavior documented outside the script. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 150:9–150:71 | `bdf1e145c395e6de3d9a2fa76f42a18accee91a5dd1642504bf530dea66523ae` | 1 | ADR | Keep legacy flag/ownership, preflight and exact structured comparison behavior documented outside the script. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 164:16–164:45 | `5a91962e5dff60b08a9db3674b73c54d856612ab46bed2a66afe5c2d92e32bd5` | 1 | Delete | The function name and local assignments already express its positional arguments. |
| 177:17–177:72 | `c378ce8524824aefc118e486bf98822634419601cce8e988e962a58bf93574fb` | 1 | Delete | The function name and its case branch expose the skip/return semantics. |
| 179:50–179:67 | `bced647a0d3d060fd50b66c6279eac6b1e23d6b0843257f29ebac46d1710bee5` | 1 | ADR | Platform exclusion protects the self-managed herdr integration. [Destination](adr/004-native-integration-policy.md). |
| 184:1–184:73 | `cd0a3e26e407858039b53027f2036b546313f7c747611a62065ed2bde704dca3` | 1 | Delete | Decorative section divider. |
| 250:5–250:95 | `cae7efb946e4a8bc12f1b6ea36d90cd4575cdc4d9d30ed3fb3698ede17e624de` | 1 | ADR | Keep legacy flag/ownership, preflight and exact structured comparison behavior documented outside the script. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 295:1–295:76 | `29b329ede342123e830ecf3ee54518e9eddaeead96b5fa97e8c92ba7de7165a4` | 1 | Delete | Decorative section divider. |
| 386:5–386:54 | `c917674e21b4b5cf2819a4d6df8a508e072cb0811d217a2fd3b43d5355f754a5` | 1 | ADR | Keep legacy flag/ownership, preflight and exact structured comparison behavior documented outside the script. [Destination](adr/001-configuration-and-host-boundaries.md). |

### `tests/codex-mcp.test.mjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/tests/codex-mcp.test.mjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 14:1–14:82 | `1fd94b7a238c5d57a6b07aa95d4b7ecfef58cb6be07f0601545e5b493eb1ae4f` | 1 | ADR | Test isolation: fake CLI does not launch a model or a server. [Destination](adr/004-native-integration-policy.md). |
| 15:1–15:49 | `562fcfbd90af6bdcd3fb2b5b2fb0cfbf9d80179c233b40069c7d7dc20451ffca` | 1 | ADR | Test isolation: fake CLI does not launch a model or a server. [Destination](adr/004-native-integration-policy.md). |
| 276:3–276:77 | `977cb473d516afce2b93d8dc925686d6e594ec3abfa60ca47bc976a1324e1547` | 1 | Delete | The pending-record fixtures and postconditions directly show what is cleared, kept or retried. |
| 284:3–284:87 | `01890b9204171a013c8f541bf3c7d92271b2dc0e48f3dc95121812792b1a19e3` | 1 | Delete | The pending-record fixtures and postconditions directly show what is cleared, kept or retried. |
| 521:86–521:120 | `2f08be6e6ccd290445dbc550022d99a9cadccb9a41a8f09169e0710c7d773e1a` | 1 | Delete | The pending-record fixtures and postconditions directly show what is cleared, kept or retried. |

### `tests/helpers/fake-agent.cjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/tests/helpers/fake-agent.cjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 1:1–1:78 | `7a397d2c86b8fec95c48928becc721332da3fdc0e9e1815170a2e13817839199` | 1 | ADR | Fixture-only state avoids production dependencies and protects real host homes. [Destination](adr/004-native-integration-policy.md). |
| 25:3–25:81 | `d945297e0f301e2655ea327b6236548ac8d42be604843430c1637f171693fa09` | 1 | ADR | Fixture-only state avoids production dependencies and protects real host homes. [Destination](adr/004-native-integration-policy.md). |
| 26:3–26:82 | `ed9ef7b56f2b4dd228254405a9da3a63042ee6707b346cb4c818c635f783543d` | 1 | ADR | Fixture-only state avoids production dependencies and protects real host homes. [Destination](adr/004-native-integration-policy.md). |
| 110:5–110:76 | `1fe5158b7a90ae9bd143d2530b99341454375561e5f22b391d26a5ec951d9d2c` | 1 | ADR | Fixture-only state avoids production dependencies and protects real host homes. [Destination](adr/004-native-integration-policy.md). |
| 111:5–111:76 | `e85f422fe90e2c63fa287fa33247da0ae543e58a0f10b5e18135cc6d3eb6d6fd` | 1 | ADR | Fixture-only state avoids production dependencies and protects real host homes. [Destination](adr/004-native-integration-policy.md). |
| 115:36–115:91 | `bd8cc85cc544d199c4cddc7f7045920bac3cce76d4e86ff56348714a2a90fc88` | 1 | Delete | Deadline-based fixture delay and the parent timeout assertion make the wait visible. |

### `tests/helpers/fake-hosts-tool.cjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/tests/helpers/fake-hosts-tool.cjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 1:1–1:72 | `6fbfc6841d638665c8e6156d666964b09060aea31ec8edc98370005db0d716ed` | 1 | ADR | Network-free fixture uses only isolated host/npm shims. [Destination](adr/004-native-integration-policy.md). |

### `tests/kitto.test.mjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/tests/kitto.test.mjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 70:1–70:85 | `fefc5eafd321eb6c0defa3b2427ddb044e371761c59b267aafe5495c5918f05f` | 1 | Delete | Git fixture functions visibly set upstream and configure the isolated mirror. |
| 81:1–81:79 | `63d4477bbc92603513609a70c46d17e2727b568411b7543c7af5a461771cf7be` | 1 | Delete | Git fixture functions visibly set upstream and configure the isolated mirror. |
| 240:3–240:82 | `061437a360ddddfa6461241f22586faa57334e64542f972dc662ab6ffda6ab5d` | 1 | Delete | Test writes incompatible legacy text then asserts rejection. |
| 300:3–300:77 | `04e43df9d0aedc7b4b14543a468ccd771790d34aec16818bf5ec1c6f273ece84` | 1 | ADR | Lifecycle tests enforce app-owned Desktop with no pnpm/CLI dependency or bundle removal. [Destination](adr/004-native-integration-policy.md). |
| 321:3–321:86 | `fe290adbc83319eec2ab632385f8eb30c4c0fd05db810f0790d421903b372d6a` | 1 | ADR | Lifecycle tests enforce app-owned Desktop with no pnpm/CLI dependency or bundle removal. [Destination](adr/004-native-integration-policy.md). |
| 429:33–429:80 | `d9f40eceb773c4a8d530c3c928548cba0c5f7cfe6cf14a116e86539cd741de3d` | 1 | Delete | Nearby scenario supplies a quoted home, and the regex asserts shell quoting. |
| 432:25–432:80 | `5ff7ebe5744082bf02885545374734ce7eeea24bc549c02211b1bbbbc2100ef6` | 1 | Delete | The no-option re-run and fixture host checks already demonstrate reuse. |
| 474:3–474:78 | `10da575cb5ca3ac75ec2ff420aeb64721cb634589785a8f2ed7c3c1f12d56eec` | 1 | Delete | Fixture removes/reinstates source, then asserts the explicit `keptSkills` ownership state. |
| 478:3–478:90 | `72d1744d0d21715dc959cdb0142f4becf7bb7d75b20c46991c71473fd704f8d5` | 1 | Delete | Fixture removes/reinstates source, then asserts the explicit `keptSkills` ownership state. |
| 597:3–597:81 | `49722d783300a586604f9555ad52ff20b87db368fbb7c5d160262da358fe5c66` | 1 | Delete | Checkpoint, verified/pending state and immutable preview are asserted in their specific update scenarios. |
| 598:3–598:87 | `450b4b4f84b0719172b2fbcc03bac7f37e0c947aa674b3d5816031e48a9d94b3` | 1 | Delete | Checkpoint, verified/pending state and immutable preview are asserted in their specific update scenarios. |
| 621:3–621:80 | `11ffc44c0a00014e69da87253a4a1f2efc3d210347373860120029aae0b55b09` | 1 | Delete | Checkpoint, verified/pending state and immutable preview are asserted in their specific update scenarios. |
| 650:3–650:85 | `39b4f8be4733c8c522a939500583dcbca0665e6b57c701b90aaab75cff57fd7b` | 1 | Delete | Checkpoint, verified/pending state and immutable preview are asserted in their specific update scenarios. |
| 667:3–667:87 | `33237b753d80463136ede543d268b37fbf2d502aff8267786befaa4f25493576` | 1 | Delete | Checkpoint, verified/pending state and immutable preview are asserted in their specific update scenarios. |
| 688:3–688:86 | `fd815db2817114bdb35fae5d637af3ad38a636dfbb6ad64bbe1a3379c7adb4a9` | 1 | Delete | Checkpoint, verified/pending state and immutable preview are asserted in their specific update scenarios. |
| 704:3–704:81 | `2388cfb3809ffe3e4e0fd0da7177f16d76c4682be79fe3398fc26ec4f4b26858` | 1 | ADR | macOS aliases and symlinked homes explain why tests require realpath identity. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 705:3–705:81 | `88cd2d83841f78fba5559969fcf4b71736f56a9d376f4c71802e5ef13b742579` | 1 | ADR | macOS aliases and symlinked homes explain why tests require realpath identity. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 706:3–706:29 | `c2d9a95ccb1a72481036c180bf5d9726b1ff42a6cb2e7ddebf87a6244988dae0` | 1 | ADR | macOS aliases and symlinked homes explain why tests require realpath identity. [Destination](adr/003-runtime-and-worktree-safety.md). |
| 731:3–731:79 | `b4cf6a9d928e924c046fdc0e03097c38095002c97face4581492ee9c6dd65ade` | 1 | ADR | Lifecycle tests enforce app-owned Desktop with no pnpm/CLI dependency or bundle removal. [Destination](adr/004-native-integration-policy.md). |
| 821:3–821:80 | `65dbdd4bff9a48dbbcc8ad7b0a6ad6df9faa5c537d93a6b7c927f6e8e06f9953` | 1 | Delete | Test fixtures and assertions already cover missing/ref recovery, no preview writes, and local-ahead behavior. |
| 822:3–822:57 | `23ca5a15e56c1effd904f5e04ef3d6dd232320cd2512993bd38398d69f78b46e` | 1 | Delete | Test fixtures and assertions already cover missing/ref recovery, no preview writes, and local-ahead behavior. |
| 848:59–848:82 | `1d873923c4b8716ca910a9a8b7f6db74fc541c1b5f045a4abc6b7dbe5dd4341b` | 1 | Delete | Test fixtures and assertions already cover missing/ref recovery, no preview writes, and local-ahead behavior. |
| 853:3–853:73 | `7019de4988f0202c923bdbb9e31bf58cca0eaec71441676822f72348436e2c05` | 1 | Delete | Test fixtures and assertions already cover missing/ref recovery, no preview writes, and local-ahead behavior. |
| 897:55–897:78 | `1d873923c4b8716ca910a9a8b7f6db74fc541c1b5f045a4abc6b7dbe5dd4341b` | 2 | Delete | Test fixtures and assertions already cover missing/ref recovery, no preview writes, and local-ahead behavior. |
| 903:3–903:69 | `de95d21bbb4442db97a1c13180dd11bc18d656aa395b3845e8b1cbc553f65447` | 1 | Delete | Test fixtures and assertions already cover missing/ref recovery, no preview writes, and local-ahead behavior. |
| 949:3–949:69 | `0f7f29fd6e46c6f23a4332354668b63dcb73913f97d60895f23bbc28717d7d09` | 1 | Delete | Test fixtures and assertions already cover missing/ref recovery, no preview writes, and local-ahead behavior. |
| 986:3–986:79 | `9116079be59c38c2c7cbc26c02dd44732223912f95219af26fe57d5f2edf0610` | 1 | Delete | Test fixtures and assertions already cover missing/ref recovery, no preview writes, and local-ahead behavior. |
| 1061:3–1061:79 | `ceeca8ba7b49804e2df15c7ab81ba1549fd97ce92cfa5a09fa4e7ad1c9bcc2f2` | 1 | Delete | The test deletes the source, breaks the runner and explicitly asserts apply failure and unchanged checkpoint. |
| 1065:59–1065:96 | `c4d613a3075a33a4a29a334aced14c1f9169a2f48d02c3479f97fa10b18ed5c4` | 1 | Delete | The test deletes the source, breaks the runner and explicitly asserts apply failure and unchanged checkpoint. |
| 1100:40–1100:89 | `4c764c741704b569e9e1596f265a8d39217a045fe6ee03a0a8c2c79558d369e1` | 1 | Delete | Installed Pi runtime is retained and verified in the detach test. |
| 1163:7–1163:85 | `3b90b13554fed640d22be4bbe76566d2512bcee0b777c6fd5f0c7af2ca142ae9` | 1 | ADR | Codex MCP translation reads only Pi MCP definitions rather than adopting Pi's other features. [Destination](adr/002-mcp-portability-and-ownership.md). |
| 1430:1–1430:81 | `32d6c2a648230b625a028c5aa33051ca11c2186402452cc21ab0e14a49684dd8` | 1 | ADR | Host tool fixtures use test-local PATH and npm with no real network. [Destination](adr/004-native-integration-policy.md). |
| 1431:1–1431:79 | `2fb02f5ee9eb1be9b29224fb6071c4e15efc09fbf87c8bc8a059842773fc5fb0` | 1 | ADR | Host tool fixtures use test-local PATH and npm with no real network. [Destination](adr/004-native-integration-policy.md). |
| 1615:3–1615:76 | `826aa48b4a66c28052e095be0d49dbd303719778ba841aa44149363b595000e1` | 1 | Delete | The named prerelease regression and asymmetric assertions express the old truncation symptom. |

### `tests/native.test.mjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/tests/native.test.mjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 10:1–10:82 | `4cc9e9c3c90bc4bd35cb845c43805681b49229cc625ce678f1633d9050f64128` | 1 | ADR | Pinned-host validation is separate and does not require login or model calls. [Destination](adr/004-native-integration-policy.md). |
| 61:3–61:77 | `abb45d29fe167146f67f90990085a8bc61ee234203b7c7dbd1da18b51bd23d90` | 1 | Delete | Fixture add/change and the resulting names/transport assertions show each scenario. |
| 77:3–77:63 | `8500315b67468868ca2fd3d34fcfb8e4be46f76297021592fd0f2c0babc88a38` | 1 | Delete | Fixture add/change and the resulting names/transport assertions show each scenario. |

### `tests/scope-codex.test.mjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/tests/scope-codex.test.mjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 76:3–76:76 | `19cb6351ebe972d22c488f7844297b1b5c39fc9d0a68f5bf3d4609e8b66be1c3` | 1 | ADR | Scope registry resolution must be independent of invoking shell environment variables. [Destination](adr/001-configuration-and-host-boundaries.md). |
| 115:7–115:78 | `2d895ec3b8438d05d50dd07c52835a029b37ea3c76e76bcca6c53269bdea68e1` | 1 | ADR | Test-only owned config is isolated; normal Codex hook review/trust stays intact. [Destination](adr/004-native-integration-policy.md). |
| 116:7–116:60 | `19ca1612a8c2bfe1a943d724899e64e44439fc068ca6328e1486afe16c41c305` | 1 | ADR | Test-only owned config is isolated; normal Codex hook review/trust stays intact. [Destination](adr/004-native-integration-policy.md). |

### `tests/scopes.test.mjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/tests/scopes.test.mjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 319:3–319:88 | `beee883d609abfed217d90e2239bc9759275bf917c2ccc0ee5b37f25c5fcc61b` | 1 | Delete | Mixed-host assertions already show that only Desktop scope setup is skipped. |

### `tests/setup-wizard.test.mjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/tests/setup-wizard.test.mjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 126:34–126:76 | `5e595e705e15931a5ec25bb63f48991d30b63e6fdb2038c81b4b46c25d212456` | 1 | Delete | Exact key sequence exercises selection; test assertions name the chosen host. |

### `tests/test_sync.py`

Parser: `Python` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/tests/test_sync.py)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 279:9–279:76 | `01637cf17906e4963841f83c59b84a92ef8c8c892948155d2d981f51394f43b6` | 1 | Delete | The negative and legacy fixtures already assert boundary rejection or whole-file acceptance; the design lives in ADR 001. |
| 280:9–280:65 | `414f16f2c300b56fc5cd3321aa0ce8ec225dc7941452ff2946e821881d8fb29d` | 1 | Delete | The negative and legacy fixtures already assert boundary rejection or whole-file acceptance; the design lives in ADR 001. |
| 286:9–286:79 | `4027c7c3473f858201e3824cae70282b55aeec1aa42bbd76389c08c5cce9e8c5` | 1 | Delete | The negative and legacy fixtures already assert boundary rejection or whole-file acceptance; the design lives in ADR 001. |
| 287:9–287:21 | `5803c2ea60d0f5aede22cb257d6bf0bdce1cbf873862f67dc642418badd24578` | 1 | Delete | The negative and legacy fixtures already assert boundary rejection or whole-file acceptance; the design lives in ADR 001. |
| 291:9–291:80 | `d962c0f4df7b8c63ac886853164404d92bd9967d7147764abee7d46856aadf65` | 1 | Delete | The negative and legacy fixtures already assert boundary rejection or whole-file acceptance; the design lives in ADR 001. |
| 292:9–292:33 | `4e73de1989600bd818bb76061cee3b044b437a4545d258a6e33619fa8e721871` | 1 | Delete | The negative and legacy fixtures already assert boundary rejection or whole-file acceptance; the design lives in ADR 001. |

### `tests/worktree-audit.test.mjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/tests/worktree-audit.test.mjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 34:1–34:83 | `75cb0db7bdc89f59c3100457036c2c16baad9f179a87cd6bb3533bf7e5b66b6e` | 1 | Delete | Snapshot captures file content and mtimes explicitly, rather than access time. |

### `tests/worktree-lifecycle.test.mjs`

Parser: `JavaScript` · Fragment: `[]` · [Baseline source](https://github.com/phyzess/kitto/blob/4400a587ef93343ec6c5c52d20b7dc8e8468638c/tests/worktree-lifecycle.test.mjs)

| Original location | SHA-256 | # | Disposition | Evidence or destination |
| --- | --- | ---: | --- | --- |
| 276:3–276:97 | `39373501130b15aa36199cc36e55af615704a458e196701bf1e78a770050d341` | 1 | ADR | Verify bytes independently of Git's stat cache even when fixture forces minimal stat checks. [Destination](adr/003-runtime-and-worktree-safety.md). |
