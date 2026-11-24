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
  | 批量、机械、扫描 | opencode-go | glm-5.3-flash / qwen3.8-flash | medium |
  | 验证与门禁 | opencode-go | gpt-6-luna | medium |
  | T1 审查 | opencode-go | kimi-k3.1-pro | high（只审 diff） |
  | T2 审查、第三意见 | opencode-go | grok-4.7（fallback kimi-k3.1-pro） | high（只审 diff） |
- opencode-go 是订阅渠道（`https://opencode.ai/inference/go`）：路由不带 `models` 时直接服务其内置目录；用 `modelOverrides` 把有效预算压到 400K（压缩触发 ~206K），`hy3` 留作 120K 短上下文批量档。
- 不走 `deepseek-official` 与 `xai` 官方渠道：两者都按量计费。需要 Grok 时用 opencode-go 的 `grok-4.7`。
- provider 与 allowlist 在会话启动时快照：改完配置要新开会话才生效；旧会话里不要规划新路由的成员，也不要把“配置已改”当作可用。
- 独立 worktree 的创建与交还按 `kitto-worktree` skill 的预览与确认流程；只在用户明确要求时执行 `apply`，不自动清理。
- 质量任务用 `kind=requirements/implementation/verification/review/integration`；implementation/repair 必须带 `verify`；review 必须 `verdict=pass` 才解锁下游。
- 规划与审查成员用 `tool_policy: "read-only"`（可跑 bash 验证，禁止 edit/write）；实现与批量用默认工具集。
- 默认 `approval: "required"`；用户说「直接跑/不用审」时才用 `automatic`。
- 队长不写产品代码（合并冲突、集成提交除外），也不批准自己写的实现。

### 上下文与成本（执行面）

- **压缩是主控项**：触发点 = `min(thresholdRatio × contextWindow, contextWindow − maxTokens − headroomTokens)`，默认 `thresholdRatio: 0.8`、`headroomTokens: 65536`，`contextWindow`/`maxTokens` 来自模型路由。按模型真实容量配 1M 窗口时触发点被推到 ~840K，实测会话就涨到了 840K prompt，44% 的请求落在 >200K 的翻倍档。
- 调阈值走**模型路由**：在 `llm-pi-ai` 里把模型的 `contextWindow` 降到有效预算（如 `400000` + `maxTokens: 128000` → 触发点 ~206K）。改 preset 的 `compaction-basic` 是另一条路，但 Web 不编辑 preset，按行 id 覆盖会整表替换（实测 354 → 322 个节点），只剩整份冻结 `plugins` 一个选项，代价是 DSH 升级后新插件被静默遮蔽。参考值见 `config/dsh/compaction.reference.yml`。
- 审计入口：`node ~/.agents/skills/context-budget/scripts/dsh-usage.mjs`。只读扫描 `$DSH_HOME/sessions`，按模型、会话、天输出 token 与折算成本；`--project` 做路径前缀过滤，`--days` 限窗口。
- 会话日志：`$DSH_HOME/sessions/<项目>/<会话 id>/session.v4.jsonl.zstd`。每条 `assistant/message` 带 `usage`（`inputTokens`、`cacheReadTokens`、`outputTokens`），模型 id 在 `message.source`；压缩与剪枝是 `compaction/*` 事件。以此为唯一事实来源，不靠估算。
- 子 agent 默认 `subagent`（干净上下文）；`subagent_fork` 只在需要延续判断时使用。一个成员同一时间一个任务，波次任务数超过 3 个拆波。
- 队长把证据与结论写进任务合同；转发原文会让每个成员各自重读一遍。
- handoff 写到 `$DSH_HOME/handoffs/<工单>-<日期>.md`，格式按 `context-budget` skill 的模板。
