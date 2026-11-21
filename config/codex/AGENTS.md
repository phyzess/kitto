## Codex 专属补充

- Codex 的 skill 回退路径是 `$CODEX_HOME/skills/<name>/SKILL.md`（默认 `~/.codex/skills/`）；首次使用 Kitto 的 SessionStart hook 时，在 Codex `/hooks` 中信任它。
- 本段由 Kitto 写入 `$CODEX_HOME/AGENTS.md` 的标记块内，块外内容保持本机所有；存在 `AGENTS.override.md` 时优先于 `AGENTS.md`。
