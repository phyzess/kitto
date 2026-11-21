## DeepSeek Harness 专属补充

- DSH 的 skill 回退路径是 `$DSH_HOME/skills/<name>/SKILL.md`（通常 `~/.dsh/skills/`）。
- DSH 的 CodeGraph MCP 工具名带 `mcp__codegraph__` 前缀；server 没有默认项目，调用时把仓库绝对路径作为 `projectPath`。
- 本段由 Kitto 写入 `$DSH_HOME/AGENTS.md` 的标记块内，块外内容保持本机所有。

### 编排执行面（AgentTeams）

- 分级与门禁按共享规则「开发任务编排」；T0 不建队，T1/T2 用 AgentTeams。
- 建队入口：`agent_teams_create({ description: <目标>, approval: "required" })`；配置了模板时优先 `/agent-teams --profile dev-standard <目标>` 或 `dev-hard`。没有模板时用 `plan.members` 内联，并显式传 `provider` + `model`。
- 路由（provider/model/effort）：
  | 角色 | provider | model | effort |
  | --- | --- | --- | --- |
  | 方案 | openai-codex | gpt-6.2-astra | high |
  | 实现/长跑 | openai-codex | gpt-6.2-sol | high |
  | 批量、T1 验证与审查 | deepseek-official | deepseek-flash | max |
  | T2 审查、第三意见 | xai | grok-4.7 | high（只审 diff） |
- Grok 默认不进 T1 团队：只在 T2 审查、GPT 与 DeepSeek 结论冲突、两轮修复仍失败、领域强项（EE/硬件/协议），或 GPT 额度受限时加入。
- 成本约束：Grok 审查只给 diff 与必要上下文（≤50k 输入），长跑任务单次可能 $1+；单任务超 $1 或整轮超 $5 先报告。
- `xai` 未配置时：T2 审查降级为 `deepseek-official/deepseek-flash`（与 GPT 实现仍跨家族），并在最终报告注明降级。
- `xai` 的 provider/allowlist 在会话启动时快照：配置后必须新开会话才能把 Grok 成员纳入计划；旧会话里不要规划 Grok 成员，也不要把“配置已改”当作可用。
- 独立 worktree 的创建与交还按 `kitto-worktree` skill 的预览与确认流程；只在用户明确要求时执行 `apply`，不自动清理。
- 质量任务用 `kind=requirements/implementation/verification/review/integration`；implementation/repair 必须带 `verify`；review 必须 `verdict=pass` 才解锁下游。
- 规划与审查成员用 `tool_policy: "read-only"`（可跑 bash 验证，禁止 edit/write）；实现与批量用默认工具集。
- 默认 `approval: "required"`；用户说「直接跑/不用审」时才用 `automatic`。
- 队长不写产品代码（合并冲突、集成提交除外），也不批准自己写的实现。
