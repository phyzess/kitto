## Codex 专属补充

- Codex 的 skill 回退路径是 `$CODEX_HOME/skills/<name>/SKILL.md`（默认 `~/.codex/skills/`）；首次使用 Kitto 的 SessionStart hook 时，在 Codex `/hooks` 中信任它。
- 本段由 Kitto 写入 `$CODEX_HOME/AGENTS.md` 的标记块内，块外内容保持本机所有；存在 `AGENTS.override.md` 时优先于 `AGENTS.md`。

### 编排能力边界

- [任务级模型路由](https://github.com/phyzess/kitto/blob/main/docs/model-routing.md)：主会话沿用当前模型或由用户用 `/model` 改选。只有当前子代理入口可指定并核实目标路由，才列为可直接派发。
- 需要决定时在 Plan 模式用原生询问；工具不存在就在聊天中一次问清，无交互则返回待决定。不能兑现项目的独立审查门禁时，保留「待外审」，附上变更和风险，不改全局通道绕过。
