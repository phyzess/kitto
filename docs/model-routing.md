# 任务级模型路由

把路由作为任务计划的一部分：用户本次选择 → 项目/角色预设 → 单角色沿用当前模型。预设只保存偏好，不保存凭据、费用授权或批准。没有适用预设时，展示实际宿主能兑现的候选；把需决定的角色合为一次询问。无答复不启动该角色及其下游。

`kitto route plan --input FILE` 计算候选和待决定项。`kitto route check --input FILE` 重算并比对知情批准。只有 `ready` 列表中的角色可纳入待启动范围；每个角色实际开始仍须满足原生任务依赖。`approvalKey` 用于检测变更，不是签名、原生授权或执行凭据。

### 计划输入

由 agent 或调用端从当前宿主和用户已经提供的信息整理，不要求用户手写 JSON。只放脱敏标识，不放凭据、提示词、源文件或个人账号地址。

- `id` 是计划稳定标识。`host` 包含 `kind`（`dsh`、`pi`、`codex`）、`surface`（DSH：`teams`、`subagent`；Pi/Codex：`current`、`subagent`）、会话 ID `session`、近五分钟的 `observedAt`、`routes`，以及单会话可选的 `current`。Codex CLI 检查另需 `host.native` 的有效 thread 信息：`thread.id`、`modelProvider`、`model`，及从当前暴露工具核实的 `spawnParameters`。它不因模型可改就声称可切换子代理 provider。
- `roles[]` 每行包含 `id`、工作范围修订 `workRevision`、`data`（`public`/`personal`/`internal`/`restricted`）、`effects`（`read`/`write`）及 `dependencies`。可用 `choice: { provider, model, effort }` 覆盖 `presets[roleId]`，或用 `choice: "defer"` 暂缓。独立审查填 `reviewGate: "independent"` 和实际 `implementers` 的 `canonicalModel`、`family`；同模型或同家族都不会通过。
- 每次规划和检查，调用端都必须从当前原生任务合同与待执行改动重新计算 `workRevision`，而不是复用批准时的值。例如在本地对 `JSON.stringify([contract, diff])` 取 SHA-256，把哈希写入 `workRevision`，不传合同或 diff 正文。Teams 的 `nativePlan` 必须从实时草案独立重算同一哈希。缺任何输入就暂停；检查器只比较调用端提交的修订值，不能自动发现未反映在输入中的编辑。
- `routes[]` 每行填可核实的 `provider`、`model`、`upstream`、脱敏 `account`、`billing`（`subscription`/`go-included`/`metered`）、`efforts`、账号证据 `accountVerified` 和当前任务数据策略 `dataAllowed`。只有原生可见时填 `available: true`，能精确原生派发时填 `dispatchable: true`；子代理需要 `fallback: "none"` 的有效配置证据。Go 还需 `quotaReady`，按量还需非负 `estimateUsd`。缺证据不填 `true`。
- 每个角色的 `authorization` 记录已经获用户或适用策略授权的 `plan`、`role`、`workRevision`、`provider`、`model`、`upstream`、`account`、`billing` 和 `data`。按量填写本任务明确同意的 `maxUsd`；检查不代表服务端成本硬上限。用户批准实际启动范围后，把对应 `{ id, approvalKey }` 放到 `approval` 数组再调用 `check`；变更后重新展示并确认。只将通过检查的角色交给原生宿主。原生面板/工具不对这份 JSON 签名。

### 执行边界

DSH Web 用 `kitto_task_routes` 或已绑定的 CLI 检查，再由原生团队草案承接选择。Teams 启动检查还需从原生暂存计划整理 `host.nativePlan`：`id`、`session`、`phase: "staged"`、以及全部待启动 `tasks[]` 的 `id`、`provider`、`model`、`effort`、`fallback`、`workRevision`、`dependencies`。角色以拟启动任务 ID 为单位，重复用同一成员时也逐任务核对工作范围。匹配检查拒绝额外任务、路由改动和未核实的回退。仅比较提交的快照；原生 Web 按钮并不读取该结果，不能把这个检查当成宿主拦截。

DSH 候选检查器目前只支持 `teams`、`subagent`，不验证父会话 `current`。Web 工具从调用者取得真实会话 ID；CLI `check` 要求宿主提供匹配的 `DSH_SESSION_ID`。没有该变量时改用 Web 工具，不能从输入复制或手工设置变量补证据；离线 `plan` 可使用输入会话 ID。

Pi 的 `/kitto-route` 读取当前会话；离线 CLI 规划和检查 `current` 都需 `host.native` 的原生状态快照。Codex CLI 使用 `host.native` 的有效 thread 快照。两端若要求非默认思考档，必须有实际档位可核对；调用端提供的快照不是签名证明。三端具体交互见 `task-model-routing` skill。

`plan` 和 `check` 都是**离线建议**。唯一受控派发是经操作者显式启用的 **DSH Web 0.2.2-rc.5、完整本机安装、默认独立 spawn `subagent`**。它在原生模型预检和 activation 之前加门禁，不替换 DSH 派发器，不调用推理 API。

**未保护**：AgentTeams（含另装的 `@nanmicoder/dsh-agent-teams` 0.1.31、Web 审批、恢复、retry、reassign、邮件唤醒）、`subagent_fork`、workflow 子调用、父会话、非默认 spawn/工具别名、Pi、Codex、Desktop、服务账号、仅 scope 安装及直接 API/JEV。都不接受为受控派发；宿主上的这些入口本身不会被 Kitto 禁用。直接 JEV 不经过门禁，保持关闭，分级与归因使用本地证据。

## 确认设备并迁移

1. 在目标机器、目标账号上运行 `kitto setup --interactive`，在完整本机 DSH 安装中选 `personal`、`company`、`custom` 或 `skip`。已有安装也可用 `kitto setup --routing-boundary company`，先加 `--dry-run` 看预览；`custom` 同时指定 `--routing-routes PROVIDER/MODEL[,PROVIDER/MODEL]`。选择 `skip` 会停用本机的确认；非交互 setup 不传选项则保留原状态。预览、scope、Desktop 和服务账号安装不会创建可用的个人确认。
2. 确认只留在本机 Kitto `state.json`，绑定账号、设备标识与 DSH profile。保留已有状态，不写凭据、共享源、DSH profile 或 allowlist。旧安装、不可读、损坏或绑定不匹配一律停派。不要从另一设备复制确认。
3. 在 DSH 原生设置里配置企业允许的上游、模型、账号和数据策略。已合并过 [模板](../config/dsh/agent-teams.profiles.yml) 的，**手工处理旧的有效 `fallback`**：成员 → profile → 全局，后一级仍可能被继承；不要把省略 YAML 字段误当成移除已有值。重启对应 profile 后新开会话，核验原生解析的计划；不能确认 fallback 已关闭就停派，内联计划也不例外。保留本机 AGENTS 自定义块；人工移除其中与新判断冲突的高端优先、自审或 JEV 默认调用。

### 一次性迁移预览

运行 `kitto route migrate --home /absolute/dsh-home`。只读显示 `AGENTS.md` Kitto 托管标记内拟插入的确切行、原生 patch 里疑似 `fallback` 的行号，以及仍需人工处理的项目。它不会打印本机自定义块、凭据或 patch 原值，不解析 YAML 合并/继承，且从不宣称 fallback 已清空。先审阅结果，再在受控变更流程中同步托管规则并按下文设置插件；不覆盖本地账号、provider、patch 其他项或凭据。

Kitto 不提供写入迁移命令。撤销真实部署需操作者关闭 `routeDispatch`、重启、验证原生配置；不要为了撤销启用而删除共享额度状态。

### 原生 `subagent` 一次性许可

1. 操作者核实 exact Web 版本和 home、默认非继承 spawn（`modelSelection` 已启用、无 alias/tool override）、无任何有效回退，服务支持并确实会展示本次工具请求的一次性批准。取得主会话的原生 ID、初始项目及当前 cwd；派发目录须在该项目内。修改现有 `phyzess-kitto` 插件行的 `config: { routeDispatch: true }`（保留其他字段），重启并开新会话。`routeDispatch` 默认关闭，版本/profile 不支持时不挂门禁；启用后此工具无许可时拒绝，不降级。`routeEvidence` 可独立启用导出。
2. 先按下文准备离线输入，在同一会话用 `list_subagent_models` 查询精确候选。操作者额外填 `host.version: "0.2.2-rc.5"`、`host.surface: "subagent"`、`host.session`、`host.spawnVerified: true`、`host.effectiveFallbacks: []`；以及 `dispatch: { "source":"operator-verified", "project":"/real/project", "callerCwd":"/real/project", "cwd":"/real/project" }`。填精确 `task.id`（无空格任务 ID）及 `task.budget: { "maxAdditionalCashUsd":0, "maxMonthlyGoFraction":0 }`；Go 的比例须明确批准并高于零，实际估算不得超过它。Go 另在 `go.pool`、拟选 `host.routes[]` 和对应 `task.authorized[]` 填同一个已核验的逻辑池 ID。使用稳定的订阅/成员共享身份，不用模型、provider 别名或 session 作池 ID，不用真实用户标识/凭据。Kitto 无法从 DSH 推断账号或原生连接器实际计费，操作者必须验证它们及数据授权；不能核实则不发许可。
3. 在可信的本机终端保存无正文、无凭据的私有 JSON（权限 0600），执行 `kitto route permit --input FILE --operator`。它只生成短时许可（至多两分钟），不启动子代理。按原样使用返回的 `native` 参数，另向原生 `subagent` 提供任务正文；在原生批准界面审核该次精确工作、数据和参数后一次性批准。不由模型自行发许可，亦不在不可信的同 UID / 任意 shell 环境打开本功能。Kitto 不读取正文；任务意图与数据分类仍由操作者审核，不是子代理的文件/网络沙箱。
4. 原生权限、批准、模型 allowlist、取消或其他 guard 可否决。许可在原生工具体之前消耗；取消、崩溃或结果不明时先人工检查，不凭同一个许可重发。正常激活只证明原生工具返回预期 activation，不证明真实结算、任务完成或首个模型请求后的路线。审查前另外核实实际实现模型与审查模型，未知则外审待定。

## 采集宿主证据（可选）

1. 在要派发的同一 DSH 会话，逐个执行 `list_subagent_models({ provider, model })`。在完整本机安装且运行 DSH Web 0.2.2-rc.5 时，可由操作者在现有 `phyzess-kitto` 插件行合并 `config: { routeEvidence: true }`（保留其他配置），重启并新开会话。Kitto 默认不启用观察器，也不自动改 profile。启用后通过原生 `tools/result` 获取成功的精确调用；执行 `kitto_route_evidence({})` 导出当前 agent、当前会话最近五分钟的模型 ID、档位及时间。不采集其他工具或正文。原生工具不存在、宿主版本未知或不在支持 profile 时，用下一条人工方式，不读取宿主日志。
2. 复制导出的对象到输入的 `host.evidence`，将原生会话 ID 填入 `host.session`。人工方式使用 `{ "source":"operator-native-result", "profile":"web", "session":"<实际会话 ID>", "routes":[{"provider":"…", "model":"…", "observedAt":"<实际采集 UTC>", "result":"<精确调用返回的原始文本>"}] }`。无效、重复、未来、过期或会话/profile 不匹配均不可用；同一导出只用于其实际来源会话。离线 JSON 可编辑，不是签名认证。阶段一手填 `host.routes` 仍支持；一旦提供 `host.evidence`，缺证据的路由不会回退到手填可用值。
3. 继续填写 `host.routes` 的账号、上游、规范 ID、计费及批准信息。普通 `subagent` 可由匹配的原生证据补上省略的 `available`；`false` 或非布尔值不补。对 `teams`，核对原生暂存成员计划后才手工填写 `available: true`；ordinary 证据只补实际档位，不替代成员计划或 fallback 核对。采集不验证账号，不能自动生成 `task.authorized`，也不能证明成员已启动。

## 一次性许可输入

1. DSH 当前会话调用 `list_subagent_models({})` 找 provider；再对候选逐一调用 `list_subagent_models({ provider, model })`，把实际显示的精确 ID 和 `Reasoning efforts` 下的 ID 填入 `host.routes`。成功才标 `available: true`；明确没有档位才填空数组 `[]`。缺失或失败的路由不要冒充可用。不配置原生子代理 allowlist 时，工具只看到父路由。如果做 AgentTeams，额外用原生暂存计划确认精确成员模型和所有继承层的 fallback；只在确认没有有效 fallback 时填 `"effectiveFallbacks": []`。普通工具的 allowlist 不是 AgentTeams 的底层授权。
2. 从当前配置和批准记录核实 `upstream`、实际规范模型 ID、逻辑账号名 `account`、`accountType` 和 `billing`，再填 `accountVerified: true`。DSH 列表不能证明这些字段；没有这份证据就不填 `true`。逻辑名例如 `work-approved`，不要填 token、内部 URL 或用户标识。不把 `host.routes` 自动复制成 `task.authorized`：后者必须来自操作者对本任务精确路由、上游、账号、计费和数据级别的确认。
3. 如有 Go 候选，从 [Go 模型目录](https://opencode.ai/docs/console/api/models/#inference-model-lists) 与 [Go Usage](https://opencode.ai/docs/console/go/#usage) 分别读原始 JSON；只用与 DSH 路由一致且允许读取额度的账号。非 Go 候选可以省略 `go`。`host.observedAt`、`go.observedAt`、`go.catalogObservedAt` 以实际采集 UTC 时间为准（如 `date -u +%FT%TZ`），不为旧快照重打时间戳。可以在获批的本机终端取快照，不把凭据、响应原文或数据写进团队日志。Kitto 不代读 key；以下是可选的操作者命令，非推理请求：

   ```sh
   # Use a private local directory; GO_KEY is already available to this shell.
   umask 077
   curl --fail --silent --show-error --max-time 10 \
     https://opencode.ai/inference/go/v1/models > go-models.json
   printf 'header = "Authorization: Bearer %s"\n' "${GO_KEY:?}" | \
     curl --config - --fail --silent --show-error --max-time 10 \
       https://opencode.ai/inference/go/v1/usage > go-usage.json
   ```

4. 保存本机 `route.json`。下面是非 Go 公司路由示例，`observedAt` 用采集时间替换；真实账号、批准和 API 路由都需单独确认。Go 候选还要填写 `task.tokens`（工作项总输入、总输出 token 上界），以及 `go` 对象：`plan`（`go` / `go-plus` / `go-teams`，查当前订阅）、`account`（与候选一致）、`extraUsage: "off"`（Console 核实，Go Teams 默认开启）、`observedAt`、`usage`（`go-usage.json` 的 `.usage`）、`catalogObservedAt`、`catalog`（完整 `go-models.json` 对象）。不要手填估计价格。

   ```json
   {
     "host": {
       "kind": "dsh", "installation": "full-local", "surface": "teams", "profile": "web",
       "observedAt": "2026-11-25T12:00:00Z", "effectiveFallbacks": [],
       "routes": [{
         "provider": "work-claude", "model": "sonnet", "canonicalModel": "anthropic/claude-sonnet-5-5",
         "upstream": "anthropic", "account": "work-approved", "accountType": "company",
         "accountVerified": true, "billing": "subscription", "available": true,
         "tier": 1, "premium": false, "reasoningEfforts": ["low", "high"]
       }]
     },
     "task": {
       "role": "implement", "effects": "write", "data": "internal", "effort": ["medium", "default"],
       "authorized": [{
         "provider": "work-claude", "model": "sonnet", "canonicalModel": "anthropic/claude-sonnet-5-5",
         "upstream": "anthropic", "account": "work-approved", "accountType": "company",
         "billing": "subscription", "data": "internal"
       }]
     }
   }
   ```

5. 在 DSH 中先加载 `kitto` skill，用它绑定的 `node <绝对 CLI 路径> route …`，不从 `PATH`、npm 缓存或项目 checkout 取入口。操作者在完整安装上也可运行 `node "$KITTO_HOME/runtime/bin/kitto.mjs" route …`（默认 Kitto home：`${XDG_DATA_HOME:-$HOME/.local/share}/kitto`）。该输入只用于下文的一次性许可、`go-metadata` 和额度记录；Teams 候选用 `plan` / `check`。

### 路由字段与比较

- `personal` 仍要求任务授权；`company` 只接收明确核实的公司账号；`custom` 额外与 setup 的精确路由名单相交。`data` 是 `public` / `personal` / `internal` / `restricted`；后两种始终需要公司账号。边界与数据字段是约束，不替代公司合规审批。
- 识别 `openai-codex`、`opencode-go`、`anthropic`、`openrouter` 作为上游，允许已核验的自定义 provider ID。Claude/OpenRouter 的规范模型身份、能力层 `tier`（0=基础、1=主力、2=高端）、`premium` 属性来自操作者核实；OpenRouter 默认按量的余额/API 不符合，只有确认属于非按量的合约或订阅且获得明确授权才填 `subscription`。未知上游、OpenCode Console/Zen 按量、官方按量路由和未核验的计费都不选。Go 填 `go-included`，其余填 `subscription`。Go v1 内置模型候选只限 DeepSeek V4.1 Flash、GLM-5.3-Flash、Hy3、GLM-5.3、Kimi K3.1 Pro、Grok 4.7、DeepSeek V4 Pro；排除免费、训练和未知目录模型。GPT 订阅内置 Sol、Astra，不回退到 Go GPT。内置短名必须匹配 Kitto 明确登记的规范模型 ID；Go 官方目录也必须一致。若短名映射到其他型号或新版本，预检停派；同厂商或同家族不代表符合原有能力和高端授权。通过其他上游使用同一内置规范模型 ID 时，也采用内置能力层及高端限制。
- `role` 是 `batch`、`verify`、`implement`、`architect`、`review`；前两者默认接受层 0，其余最低层 1。需要更强能力用 `minTier` 提高下限；高端路线的授权项必须另写 `premium: true`。依次按非高端、满足下限的最低档、Go 归一化估计和路由 ID 取稳定结果；无共享池消耗的独立订阅在同档优先。
- `effort` 是可接受档位的有序列表。每次重新与选中路由的支持列表求交；`default` 只有明确列出才可用，普通子 agent 省略该字段，AgentTeams 显式传 `default`。不要把失败路由的 effort 直接用于下一条路由。
- `review` 还需要 `task.implementers: [{"canonicalModel":"openai/gpt-6.2-sol"}]`：列出实际参与实现的所有模型，规范 ID 从原生实际生效路由核对，不能填写拟用路由。保守按模型厂商分组为家族，换 provider、代理、同一家族的型号都不算独立；无法确认则待外审。

## 自适应预检、峰谷策略与多池健康

预检分两步：`probe` 采集脚本证据，`resolve` 在证据上算出可派发方案。两者都是离线建议，不启动推理、不改宿主配置。

### 命令

```sh
kitto route probe [--allow-network] [--pools UPSTREAM[:POOL],...] [--now ISO] [--no-cache] [--json]
kitto route resolve --input FILE [--probe FILE] [--policy balanced|cost-first|quality-first] [--now ISO] [--no-auto-probe]
kitto route report-failure --pool POOL --upstream UPSTREAM --kind quota|rate_limit|outage|auth [--window 5h|rolling|weekly|monthly|balance|unknown] [--resets-at ISO] [--reason TEXT] [--now ISO]
kitto route clear-pool --pool POOL --upstream UPSTREAM [--reason TEXT] [--now ISO]
```

- `probe` 输出 `schema: 1` 快照（`observedAt`、`networkUsed`、`pricingWindows`、`pools`、`warnings`），并默认写入 `$KITTO_HOME/routing-v2/probe-cache.json`；`--no-cache` 只读不写。未给 `--pools` 时覆盖 `opencode-go`、`openai-codex`、`deepseek-official`、`anthropic`、`openrouter` 五个默认池。
- `resolve` 优先用 `--probe` 指定的快照，否则读 5 分钟内的本机缓存；缓存过期或缺失时自动跑一次离线 probe（`--no-auto-probe` 关闭该行为）。结果尾部附 `decisionPrompt`，`status` 为 `invalid`/`unavailable`/`pending` 时退出码为 2。
- `report-failure` 与 `clear-pool` 写本机池健康账本，不联网。

### 分层探测（诚实区分主动与被动）

- **主动、零推理 GET**：`opencode-go` 读官方 usage，`deepseek-official` 读余额，`openrouter` 读 key 额度。只有 `--allow-network` 才会联网；凭据只从 `KITTO_GO_METADATA_KEY`/`OPENCODE_GO_API_KEY`、`DEEPSEEK_API_KEY`、`OPENROUTER_API_KEY` 读取，缺失即 `missing-credential`，不发请求。请求固定 `GET`、`redirect: 'error'`、`credentials: 'omit'`、5 秒上限、512 KiB 上限、无重试。
- **被动**：`openai-codex` 与 `anthropic` 没有零推理额度接口，只读本机账本里的既有记录；可选按 `$KITTO_HOME/routing-profiles.json` 的 `poolSoftBudgets` 做本地 burn-rate 判断（5h/周 USD 或请求数达到软预算 80% 记为 `tight`）。这不代表上游实际余量。
- 快照把探测失败与探测成功分开：`probe-error`、`probe-timeout`、`probe-http-auth-error` 不会伪装成健康，凭据错误写入 `auth-broken`。

### UTC 价格窗口

- 内置 `deepseek-peak-utc` 排程覆盖 `deepseek/deepseek-v4.1-flash-1017` 与 `deepseek/deepseek-v4-pro`：周一至周五 `01:00-04:00` 与 `06:00-10:00` UTC 为 2× 峰时，其余时段 1× 谷时，周末固定谷时（`weekend-off-peak`）。
- 15 分钟边界缓冲加上角色的 `expectedDurationMinutes` 前瞻：即将进入峰时标为 `entering-peak-window-soon`，评分按峰时乘子计入，因此批量/验证角色会提前避开。
- 节假日没有内置日历：只在 `$KITTO_HOME/routing-profiles.json` 的 `holidayOverrides`（`YYYY-MM-DD` UTC 日期列表，`schema: 1`）里显式列出才按谷时计。未列出仍按工作日峰时保守估计。
- 长上下文按目录里的 `longContextThreshold`（如 200K/272K）切到长上下文档单价，标注 `long-context-doubled` 并加惩罚分，不按平均价估算。
- 同一文件里不允许出现 token/key/secret/password 类字段名；命中即整份配置失效（`secret-like-field-disallowed`），预检不引用它。

### 自动改道与确认门禁

`resolve` 的每行状态是 `ready`、`auto-rerouted`、`decision-required`、`unavailable` 或 `deferred`。

- **同边界自动改道**：仅在已授权的 `subscription` 或 `go-included` 路由、账号已核验、数据策略允许时采纳，并给出 `rerouteReason`：`deepseek-peak-avoided`、`pool-pressure-tight`、`pool-held-quota:<窗口>`、`pool-headroom-reallocated`、`expected-route-not-offered`、`higher-priority-policy-route`，或被拒路由的具体原因。计划与 `team:` 行必须披露该原因。
- **必须确认**：按量（`metered-cost-not-authorized`）、高端档（`premium-not-approved`）、账号或计费未核验（`verify-account-and-billing`）、数据策略未确认（`verify-data-policy`）、需原生面板选择、原生思考档不一致，都落为 `decision-required`，每项只问一次。
- **失败关闸**：`auth-broken`、`held-outage`、`held-quota` 的池整条路由被拒；账本损坏、`observedAt` 超前 60 秒以上、或残留事务锁一律视为 `pool-health-state-invalid`/`needs-reprobe`，按不可用处理，不猜余量。
- **故障上报**：`quota` 记 `held-quota`（窗口默认 `unknown`）；`rate_limit` 记 `held-quota` 并默认 15 分钟后重探；`outage` 记 `held-outage`，连续失败按 2/5/15 分钟退避；`auth` 记 `auth-broken`，不随时间自愈。`resetsAt` 到点后变成 `needs-reprobe`（可用但需新证据），`clear-pool` 显式写回健康。

### 粘性、长上下文与多角色 Go 余量

- **热缓存粘性**：`sessionStickyRoute` 给已运行会话的当前路由一个强偏好，进入峰时不会中途换模；交付收口、handoff 或撞硬限额时才切换。
- **多角色聚合**：对每个有 Go meter 的池，按 `maxMonthlyGoFraction` 或 `估计 USD / 池月额度` 累加同一波所有角色，超过 `meter.remaining` 时从低优先级角色（批量、验证先）开始改到其他可用池，理由为 `pool-headroom-reallocated`。
- **只读建议**：probe/resolve 都不是预留、硬预算或进行中请求取消；实际派发仍由宿主原生能力与 `plan`/`check` 决定。

## 显式采集 Go 元数据（可选）

在已核验的本机终端准备 `go: { "account":"my-go", "plan":"go", "extraUsage":"off", "metadata":null }`，以及 `goRead: { "provider":"opencode-go", "model":"deepseek-v4.1-flash", "account":"my-go", "allow":true, "credentialBindingConfirmed":true, "credentialKind":"personal" }`。只在操作者已核实要读取的凭据确属该获准账号、已授权本次 meter 读取、上游账号/数据用途/套餐均确认时设置两个 `true`。用本机秘密管理方式设置 `KITTO_GO_METADATA_KEY`；不把 key 放进参数、JSON、命令历史或代理上下文。Go Teams 必须使用对应成员的个人 key；接口不能推断账户、套餐或 Extra Usage。

运行 `kitto route go-metadata --input route.json --allow-network`。采集前要求当前 DSH home 与本机安装状态中的绝对 `dshHome` 一致；未设置或留空 `DSH_HOME` 时按原生默认 `~/.dsh` 计算。非默认目录须显式设置绝对 `DSH_HOME`（不要填未展开的 `~` 或相对路径）；不匹配时不会读 key。唯一联网操作是官方 HTTPS `GET` 模型与 usage 元数据，无推理、重试或重定向，总时限 10 秒。成功对象复制到 `go.metadata`；其中只含通过核验的预置模型价格及该账号窗口。其他候选仍须分别满足宿主能力与本任务授权。若失败，把 `go.metadata` 保持为 `null` 或填失败对象；不要保留旧成功快照来掩盖失败。本次 Go 无有效证据时，受控许可仍可比较已批准的非 Go 路由。

## Go 额度与换路

- [Go Usage limits](https://opencode.ai/docs/console/go/#usage-limits) 的 5 小时窗口从首笔开始、上限是月额度的 20%；周窗口是 50%，周一 00:00 UTC 重置；月窗口是 100%，按付费周期重置。取三个窗口中最小的月额度剩余，并留下 1 个显示百分点给整数精度。已到重置时间必须重新读，不能把旧值当 0%。meter 或宿主能力证据超过 5 分钟失效，目录超过 24 小时失效。缺失、部分、错误、过期或耗尽均不会选 Go；这只是快照，不能预留额度。
- 估计以 `go.monthly_usage[plan]` 为分母；使用官方文本输入/输出价格、最贵的缓存写入/上下文档和峰值 multiplier 保守估计，不计算非文本用量。已有请求可选填 `go.lastRequest: { model, usage }`（`usage` 含 [官方 `opencode`](https://opencode.ai/docs/console/api/inference/#cost)，不传正文）。计入比例优先用 `opencode.allowance / monthly_usage[plan]`；没有 `allowance` 才以 `opencode.list_cost` 报估计；二者不代表池余额，也不以 `usage.cost: 0` 代替额度。当前不从响应滚动更新 meter。
- 受控派发的 paid-Go 已确认 quota 故障，由操作者对照同一次**已激活**许可和原生结构化证据后记录：`kitto route record-quota --input FILE --operator`，输入 `{ "attempt":"kr-…", "route":{"provider":"…","model":"…","upstream":"opencode-go","account":"…"}, "pool":"…", "code":"ACCOUNT_QUOTA", "observedAt":"<实际 UTC>", "source":"operator-verified-native-failure", "quotaScope":"paid-go-pool" }`。亦接受已核实为池额度的 `QUOTA` 或 `RATE_LIMIT`；HTTP 429、错误文本、工具故障或未激活许可不能独自写入共享状态。Kitto 不从会话日志或恢复事件尝试关联账号。状态在同一 Kitto home 下跨会话/进程共享；不同设备不会同步。
- 共享 hold 不因本机时间或 `Retry-After` 自行消失。依据已验证权威重置或操作者重新授权，运行 `kitto route release-pool --input FILE --operator`，输入 `{ "pool":"…", "afterAttempt":"kr-…", "source":"authoritative-reset", "observedAt":"<实际 UTC>" }`；显式重新授权用 `operator-reauthorization`，且不替代最新 meter。释放只对应 `afterAttempt`；另一尝试的同刻或乱序故障会重新冻结该池，后续释放必须晚于已知的最新故障或释放时间。残留锁不按时间自动移除。损坏、未来时间或残留锁仅对相应 Go 池拒绝，操作者先确认没有并发事务再核对/修复状态，不删除 hold 来绕过。其他已获批非 Go 路由及本地任务不受影响。只读、预算、额度与状态检查发生在 activation 前，不是配额预留、进行中请求取消、硬 token 限额、跨工具全局预算或现金保证。
