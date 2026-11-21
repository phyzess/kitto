# Vendored shared skills

These are byte-for-byte copies of the linked directories at immutable Git commits. Each destination also includes the upstream MIT notice, copied separately so it travels with the skill during sync.

| Destination | Upstream directory | License source |
| --- | --- | --- |
| `skills/writing-for-agents/` | [mattpocock/skills: skills/productivity/writing-for-agents](https://github.com/mattpocock/skills/tree/abeeaf95660ba9e8b7c753eb38f441ca707a8823/skills/productivity/writing-for-agents) | [LICENSE](https://github.com/mattpocock/skills/blob/abeeaf95660ba9e8b7c753eb38f441ca707a8823/LICENSE) |
| `skills/benchmark-checklist/` | [cursor/plugins: pstack/skills/benchmark-checklist](https://github.com/cursor/plugins/tree/d42aff08aa58965d2735c4ead61a9af82b89d0d0/pstack/skills/benchmark-checklist) | [pstack/LICENSE](https://github.com/cursor/plugins/blob/d42aff08aa58965d2735c4ead61a9af82b89d0d0/pstack/LICENSE) |

## Offline integrity check

From the Kitto root, compare the committed tree (paths, modes and contents, excluding the added notice) and license blob to the pinned upstream Git object IDs:

```sh
set -eu
verify() {
  dir="HEAD:skills/$1"
  test "$(git ls-tree "$dir" | awk -F '\t' '$2 != "LICENSE"' | git mktree)" = "$2"
  test "$(git rev-parse "$dir/LICENSE")" = "$3"
}
verify writing-for-agents ad2925850efb8973a72d2e666f7a975f9a2d4a9b f1dd2c09108dde1a5f56097cee8461b3ea834499
verify benchmark-checklist 95621ebe5e1571f3689186adc741c2de2ab96552 6b5400237fdf6545be0b8fae370d6f2fcff8fb25
```
