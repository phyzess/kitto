# 开发任务编排

一套跨 Pi、Codex、DSH 的开发任务编排规则：按任务形态分级，匹配模型家族，用硬门禁保证质量。内容放在 Kitto，随规则共享层部署。

## 分层

| 层 | 文件 | 作用 |
| --- | --- | --- |
| 共享规则 | `config/instructions/common.md` → 「开发任务编排」 | 开工声明、T0/T1/T2 分级、模型分工、硬门禁与验证纪律。所有宿主都会拿到。 |
| 宿主 addendum | `config/dsh/AGENTS.md`、`config/codex/AGENTS.md`、`config/pi/AGENTS.md` | 各宿主的执行面：AgentTeams 路由、单模型降级、Pi 能力适配。 |
| 共享 skill | `skills/dev-orchestration/SKILL.md` | 完整 playbook：DAG 模板、任务合同、证据、升级、反模式。部署到 `~/.agents/skills`。 |
| 共享 skill（成本） | `skills/context-budget/SKILL.md` | 上下文阈值、handoff 模板、审计用法与反模式。 |
| 审计脚本 | `skills/context-budget/scripts/dsh-usage.mjs` | 只读扫 `$DSH_HOME/sessions`，出模型/项目/天/会话四张表与扇出、分位数。随 skill 一起部署。 |
| 结构化判定 | `skills/jev-decide/SKILL.md` + `scripts/jev.mjs` | 用 System One 决策模型做一次性判定（分级、归因、要不要加人），返回概率而不是正文；端点在 Go 渠道，计入订阅额度。 |
| DSH 原生配置（压缩） | `config/dsh/compaction.reference.yml` | 压缩触发点参考值；Kitto 不部署，改模型路由的 `contextWindow`。 |
| DSH 原生配置 | `config/dsh/agent-teams.profiles.yml` | AgentTeams 的 `profiles` 与 `toolPolicies` 参考片段。Kitto 不部署，需手工合并到 profile patch。 |

## 为什么这样分层

- **规则要跨宿主**：分级、门禁、证据要求与宿主无关，放 `common.md` 一次生效。
- **执行面必须分宿主**：DSH 有 AgentTeams 与多 provider；Codex 只有 GPT；Pi 的模型路由在 settings。把这些写进 common 会让规则变成空话。
- **细节放 skill**：AGENTS.md 常驻上下文，只留判定与门禁；DAG 模板、合同写法、升级触发按需加载。
- **DSH 配置不进 Kitto 部署**：Kitto 只写 AGENTS.md、skills 和 bundle 注册，不写 profile patch。用参考文件 + 手工合并，避免 Kitto 越权改宿主配置。

## 可执行性纪律

规则只有“能被检查”才生效。以下五条是 2026-11-21 实测后补的：

1. **开工声明**：收到开发任务后的第一条回复必须输出 `tier / team / gate` 三行，之后才做调查、提问、建队或改文件；需求不完整时按 T2 记并把缺失写进 `gate`；调查后如级别变化，必须显式写「分级修正：X → Y」并说明理由；T1/T2 单人执行要说明理由并等确认。
2. **项目流程优先**：项目 AGENTS、工单状态与评审门禁优先；项目要求 ready 或负责人确认时停在那一层，不自行推进。
3. **验证纪律**：只跑受影响的定向测试；构建、全量套件与端到端属于 PR 门禁，未经明确要求不跑。
4. **路由现实**：provider 与 allowlist 在会话启动时快照，改完路由必须新开会话才能规划新成员；Grok 走 opencode-go，不配 xAI 官方渠道。
5. **工具纪律**：读源码用 `read`，查找用 `grep`/`glob`，结构先 `codegraph`；并行批量读；连续 8 步只读未成形就停下写假设。

实测结论：只写“建议”不会触发分级与组队；必须把声明做成开工门禁，并允许“单人执行但留下理由”这一显式降级。

## 上下文与成本

编排的第二个成本面不是模型单价，是上下文生命周期。根因在机制层，不在纪律层：DSH 的 `compaction-basic` 默认 `thresholdRatio: 0.8`，按上下文窗口的比例触发；1M 窗口的模型要涨到 ~840K prompt 才压缩，而 Grok/OpenAI 的翻倍档从 200K 就开始了。实测会话正好顶到 840.5K，日志里只有工具结果剪枝（`compaction/prune`），没有任何摘要压缩。所以先把触发点压到 200K 附近（改模型路由的 `contextWindow`，见 `config/dsh/compaction.reference.yml`），再谈会话纪律。

2026-11-19~24 实测（`node ~/.agents/skills/context-budget/scripts/dsh-usage.mjs`）：

- 5.37B 输入 token、15.4M 输出，折算约 $850；输入是输出的 348 倍。
- 98% 的输入是缓存读——缓存工作正常，问题是绝对量。
- 子 agent 占 76%（5.0x 扇出，18,700 次请求，平均 prompt 218K）。
- 中位会话的 prompt 从首次到末次涨 11.5 倍（p90 28.5x）；44% 的请求 >200K，占 73% 的 token；单请求 p99 是 773K。
- 5 个常驻协调会话占 91%；三个只读核查会话占 21%。

按模型看的单价差同样重要：DeepSeek V4.1 Flash 经 opencode-go 的缓存读只要 $0.0024/M，GPT-6.2 Sol 是 $0.10/M，差 40 倍。同样 1B token，一个是 $3，一个是 $100。所以判断"贵不贵"必须换成钱，不能看 token 数。

落地分四层：

| 层 | 位置 | 作用 |
| --- | --- | --- |
| 机制 | `config/dsh/compaction.reference.yml` | 压缩触发公式、`contextWindow` 参考值与验证方法。Kitto 不部署，改 profile 的模型路由。 |
| 不变量 | `config/instructions/common.md` →「上下文与成本」 | 压缩阈值、prompt 红线、会话边界、干净上下文、只读聚合、波次规模。所有宿主都拿到。 |
| DSH 执行面 | `config/dsh/AGENTS.md` →「上下文与成本（执行面）」 | 审计入口、会话日志位置、`subagent` 与 `subagent_fork` 的选择。 |
| 完整协议 | `skills/context-budget/SKILL.md` | 阈值表、handoff 模板、按收益排序的动作、反模式。 |
| 审计 | `skills/context-budget/scripts/dsh-usage.mjs` | 只读复算上面所有数字；改完策略后用它验收。 |

为什么放规则层：阈值只有每次会话都看得到才会被执行，放进 skill 会被"需要时再说"跳过。所以 `common.md` 只留判定与动作，细节和测量在 skill。项目侧的落地面（工单会话、只读核查、波次规模）写在项目自己的 `AGENTS.md` 或 `docs/process/conventions.md`，不复制这里的规则。

## Grok 的取舍

两个订阅覆盖全部角色：GPT（`openai-codex`）承担方案与实现，opencode-go 承担批量、验证与审查；deepseek 官方 API 与 xAI 官方 API 都按量计费，不进日常流程。

日常批量、扫描和验证先用 DeepSeek V4.1 Flash 或 GLM-5.3-Flash，T1 审查优先 GLM-5.3。需要 GPT 时用自有订阅，不自动改走 Go 的 GPT。

Grok 留给三类困难任务：

1. **T2 高风险审查**（鉴权/支付/并发/迁移）——换模型的独立判断，单次只审 diff，走 opencode-go 的 `grok-4.7`（$2/$6，缓存 $0.50，计入 Go 额度）。
2. **第三意见**——GPT 与审查模型结论冲突，或两轮修复仍失败。
3. **复杂领域攻坚**——例如硬件、协议的疑难分析。额度不足本身不构成升级到 Grok 的理由。

不建议让它承接日常实现或长跑：AA Coding Agent Index 它排第 4，低于 GPT-6 Astra；单任务输出 token 约是 GPT-6 Astra 的 3 倍。同档还有 `kimi-k3.1-pro`（$2/$10）与 `deepseek-v4-pro`（$1.74/$3.48），按任务挑。

## DSH 侧落地

1. 配置订阅渠道：GPT 走 Codex 登录（`openai-codex`）；opencode-go 在 profile 的 `llm-pi-ai.providers` 下写 `apiKeyEnv: OPENCODE_GO_API_KEY`，路由不带 `models` 时直接服务其内置目录。不配置 `xai` 官方渠道。
2. 把 `config/dsh/agent-teams.profiles.yml` 的 agent-teams 条目合并到 `~/.dsh/profiles/web/cordis.patch.yml`。同 id 覆盖要保留 `stateDir` 与 `memberProvider`；子 agent 的 `allowedModels` 保留自有 GPT，排除 Go 的 GPT 路由。
3. 用 `modelOverrides` 给 opencode-go 的常用模型设有效预算（400K 窗口 + 128K 输出 → 压缩触发 ~206K），参考 `config/dsh/compaction.reference.yml`。
4. 重启 web profile，刷新页面；**新开一个会话**再验收（provider 与 allowlist 都在会话启动时快照）。
5. 验收：`/agent-teams --profile dev-standard <目标>` 能生成暂存计划；成员卡片显示 provider/model；`agent_teams_status` 能看到 tool policy。

任务 worktree 的创建与交还走 `kitto-worktree` skill 的预览/确认流程；只在用户明确要求时执行 `apply`，不自动清理。

opencode-go 不可用时：审查降到 GPT 档，报告注明「同模型复核，未换模型」；长跑默认就是 GPT Sol。

## Pi / Codex

- 本机 Kitto 目前只装了 DSH。要用 Pi/Codex 的一致体验，在 Kitto setup 时勾选对应宿主；共享规则与 skill 会自动部署。
- Codex 只有 GPT 模型：T2 保留「待外部审查」，不假装换模型独立审查。需要真独立审查时转到 DSH AgentTeams。
- Pi 多 provider 时可完整执行分级；单 provider 时按 Codex 降级规则。

## 修改与回滚

- 改规则：编辑本仓库文件 → `kitto sync` 预览 → `kitto sync --apply` → 新会话生效。
- 回滚：`git checkout -- config skills` 后重新 sync。
- 跨机器：提交并推送后，另一台机器 `kitto update --apply`。
