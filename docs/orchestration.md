# 开发任务编排

一套跨 Pi、Codex、DSH 的开发任务编排规则：按任务形态分级，匹配模型家族，用硬门禁保证质量。内容放在 Kitto，随规则共享层部署。

## 分层

| 层 | 文件 | 作用 |
| --- | --- | --- |
| 共享规则 | `config/instructions/common.md` → 「开发任务编排」 | 开工声明、T0/T1/T2 分级、家族分工、硬门禁与验证纪律。所有宿主都会拿到。 |
| 宿主 addendum | `config/dsh/AGENTS.md`、`config/codex/AGENTS.md`、`config/pi/AGENTS.md` | 各宿主的执行面：AgentTeams 路由、单模型降级、Pi 能力适配。 |
| 共享 skill | `skills/dev-orchestration/SKILL.md` | 完整 playbook：DAG 模板、任务合同、证据、升级、反模式。部署到 `~/.agents/skills`。 |
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
4. **路由现实**：Grok 的 provider/allowlist 在会话启动时快照，配置后必须新开会话才能规划 Grok 成员；T1 不依赖 xai。
5. **工具纪律**：读源码用 `read`，查找用 `grep`/`glob`，结构先 `codegraph`；并行批量读；连续 8 步只读未成形就停下写假设。

实测结论：只写“建议”不会触发分级与组队；必须把声明做成开工门禁，并允许“单人执行但留下理由”这一显式降级。

## Grok 的取舍

已有 GPT 订阅和 DeepSeek API 时，Grok 不是必需项：跨家族审查由 DeepSeek 就能满足，GPT 订阅覆盖实现与长跑，边际成本为零。

Grok 只在四类场景值得出现：

1. **T2 高风险审查**（鉴权/支付/并发/迁移）——第三家族的独立判断，单次只审 diff，约 $0.1–0.3。
2. **第三意见**——GPT 与 DeepSeek 结论冲突，或两轮修复仍失败。
3. **领域强项**——EE/硬件/协议、法律与医疗文档（Grok 4.7 的 EEBench 64%、Harvey 19.6%）。
4. **额度兜底**——GPT 订阅限流时的长任务。

不建议让它承接日常实现或长跑：AA Coding Agent Index 它排第 4，低于 GPT-6 Astra；单任务输出 token 约是 GPT-6 Astra 的 3 倍，长跑一次可到 $1，是 DeepSeek 的 5–10 倍。

## DSH 侧落地

1. 配置 Grok 路由：设置 → 模型 → 添加模型提供商 → 自定义模型 API。Provider ID `xai`，协议 OpenAI Responses，地址 `https://api.x.ai/v1`，模型 `grok-4.7`，上下文 500000，输入 text+image，推理等级 low/medium/high/xhigh，凭据 `XAI_API_KEY`。输入超过 200k token 时单价升到 $4/$12。
2. 把 `config/dsh/agent-teams.profiles.yml` 的 agent-teams 条目合并到 `~/.dsh/profiles/web/cordis.patch.yml`。同 id 覆盖要保留 `stateDir` 与 `memberProvider`。
3. 重启 web profile，刷新页面；**新开一个会话**再验收（xai 与模板都在会话启动时快照）。
4. 验收：`/agent-teams --profile dev-standard <目标>` 能生成暂存计划；成员卡片显示 provider/model；`agent_teams_status` 能看到 tool policy。

任务 worktree 的创建与交还走 `kitto-worktree` skill 的预览/确认流程；只在用户明确要求时执行 `apply`，不自动清理。

没有 Grok 时整套规则仍可用：T2 审查按 fallback 降到 DeepSeek，报告注明降级；长跑默认就是 GPT Sol。

## Pi / Codex

- 本机 Kitto 目前只装了 DSH。要用 Pi/Codex 的一致体验，在 Kitto setup 时勾选对应宿主；共享规则与 skill 会自动部署。
- Codex 只有 GPT 家族：T2 保留「待外部审查」，不假装跨家族。需要真跨家族时转到 DSH AgentTeams。
- Pi 多 provider 时可完整执行分级；单 provider 时按 Codex 降级规则。

## 修改与回滚

- 改规则：编辑本仓库文件 → `kitto sync` 预览 → `kitto sync --apply` → 新会话生效。
- 回滚：`git checkout -- config skills` 后重新 sync。
- 跨机器：提交并推送后，另一台机器 `kitto update --apply`。
