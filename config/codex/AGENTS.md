## Codex 专属补充

- Codex 的 skill 回退路径是 `$CODEX_HOME/skills/<name>/SKILL.md`（默认 `~/.codex/skills/`）；首次使用 Kitto 的 SessionStart hook 时，在 Codex `/hooks` 中信任它。
- 本段由 Kitto 写入 `$CODEX_HOME/AGENTS.md` 的标记块内，块外内容保持本机所有；存在 `AGENTS.override.md` 时优先于 `AGENTS.md`。

### 编排能力边界

- Codex 只接 GPT 家族：可独立完成 T0/T1，可承担 T2 的实现与验证，但不能自己完成跨家族审查。
- T2 在 Codex 里收尾时必须保留一条「待外部审查」记录：改动摘要、风险点、建议审查模型（Grok/DeepSeek），不得声称已通过跨家族门禁。
- 让同一模型换提示再审一次只算同家族复核，不能替代跨家族审查；高风险变更建议转到 DSH AgentTeams 或多路由宿主执行。
- 本机未接入其他 provider 时，不要用改 baseURL、接非官方中转或 cc-switch 之类方式绕过；按单模型降级规则执行。
