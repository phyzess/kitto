# 配置与同步

[返回首页](../README.md)

## 一次设置，自动发现之后新建的工作区

在终端运行 `npx --yes @phyzess/kitto@latest setup`（已有源码时在源码根目录运行 `./setup.sh --source .`；本机已 setup 过则直接 `./setup.sh` 复用 state 中的配置源）。选择宿主、配置来源和可选依赖，在「工作区父目录」填入存放工作区的目录，例如 `/home/dsh/workspaces`。服务端和终端使用不同账号时，在向导中选择检测到的 DSH 系统服务。每个账号有自己的全局配置目录。要让终端和 DSH 服务读取同一份工作区文件，两边应使用相同的工作区绝对路径，并能读取其中的文件。`--dry-run` 只预览 Kitto setup 的计划，不写盘；旧版 Pi 的 `sync.sh` 预览路径已移除。

```text
/home/dsh/workspaces/
├── workspace-1/
│   ├── AGENTS.md                     # 可选，适用于 workspace-1 下所有 repo
│   ├── .agents/skills/review/SKILL.md
│   └── repo-a/
└── workspace-2/
    └── repo-b/
```

父目录及其子目录都可以在 setup 之后创建。在 repo-a 中开启新会话就会加载全局配置和 workspace-1 的配置。在 repo-b 中则加载全局配置和 workspace-2 的配置。普通工作区无需创建任何 Kitto 文件。

## 只读盘点 Git worktree

```sh
kitto worktree audit                             # 从当前仓库（含子目录）盘点
kitto worktree audit --workspace '/path/to/workspace' --json
```

显式工作区若自身有 `.git` 就只盘点该仓库，否则查找直属真实目录中带 `.git` 的仓库。不递归扫描、不遍历 Kitto scope、不跟随工作区别名子目录。按 Git common dir 去重，再列出 Git 登记的所有树（可能在工作区之外），不是按目录名猜。工作树路径需能用 UTF-8 表示；无法解析清单时报错，不返回替代路径。

按 `du -skx` 的估算字节数降序排列；未知排最后，不当作零。这个值包括目录里同一文件系统上的文件（主 checkout 可能含对象库），不是保证可回收的空间，也不宜直接相加。`--json` 保留原始路径、分支/HEAD、主树、锁定、prunable、修改、未跟踪/忽略文件等事实和阻塞项。`mergedIntoLocalBase` 只比较本地记录的 HEAD 与主树 HEAD，不访问远端，不证明 PR 已合并或内容已交付。子模块内容未检查；有 split index 时跳过索引探测（Git 的读操作也可能改变共享索引时间戳）。配置了 clean/process filter 时不运行 status，避免执行外部程序。数据是逐树的本地观察，不是原子快照。

无所有权登记的树一律 `unmanaged`，占用为 `unknown`；目录名、时间、归档或干净状态都不能证明可清理。命令不获取远端、不刷新索引、不登记、不删除；没有 `--apply`。

## 手动开工与安全收尾 Git worktree

1. **开工预览**：`kitto worktree start --repo PATH --task ID --session ID`。`PATH` 必须是主 checkout，且已登记为 workspace 或直接位于登记的 workspace-parent 下；仅有 global scope 不够。使用稳定的任务 ID 和每个会话独立的 ID（字母、数字、点、下划线或连字符，最长 80 字符，首字符为字母或数字）。命令输出将创建或复用的分支、路径、主分支提交及确认令牌，不写 Git 或台账。核对后由用户重跑同一命令并加 `--confirm TOKEN`。同一仓库同一任务复用原树并登记该会话，不继承别的 clone 或设备的树。命令不会切换调用者的 cwd；自行在返回路径打开新终端或会话，也不要假定宿主会自动套用主树的 Kitto scope。
2. **退出子任务**：所有会在树中工作的会话（含子任务）使用独立 `--session`，先确认开工。确实关闭该会话的编辑器、进程及子任务后，从树外运行 `kitto worktree finish --repo PATH --task ID --session ID --quiescent --release`。需要释放登记时，由用户把同一参数用于 `kitto worktree apply` 并加 `--confirm TOKEN`。这不会删除树；仍用最后一个登记做实际收尾。没有活跃登记时必须重新 `start`，不猜测占用。
3. **收尾预览**：从树外运行 `kitto worktree finish --repo PATH --task ID --session ID --quiescent --delivered SHA`。`SHA` 是用户已独立核实交付后提供的完整本地主树 HEAD；还要求任务 HEAD 是其祖先。不联网验证交付，squash/rebase 后无祖先证明时不会删除。`--quiescent` 是操作者对宿主、其他会话、子任务、终端、外部写入进程和挂载均已退出的人工确认，不得由 agent 从归档、空闲、Git 状态或超时推断。若无法核实、存在其他登记或宿主也是清理者，停止。
4. **显式执行**：只有当前预览无阻塞且用户授权后，运行 `kitto worktree apply --repo PATH --task ID --session ID --quiescent --delivered SHA --confirm TOKEN`。该命令重新持锁，核对 scope、台账代次、双向 Git 绑定、HEAD 与文件状态；旧令牌或未知状态不执行。跟踪修改、未跟踪/忽略文件、额外空目录、Git 锁与操作状态、子模块、部分检查等都阻塞。使用不带 `--force` 的 `git worktree remove`；不删分支，不 prune/unlock，不自动接管历史树。

即使 `git status` 显示干净，预览与执行也会直接读取跟踪文件的字节、符号链接自身的目标字节及 Git mode，按仓库的对象格式核对索引和任务提交树；任务提交还须满足上述交付祖先条件。不依赖索引的 stat 缓存。内容、mode 或读取结果无法核实，或者存在显式内容转换属性、换行转换或过滤器时，保守阻塞（不运行外部过滤器来证明干净）。

台账和工作树位于 `${XDG_STATE_HOME:-$HOME/.local/state}/kitto-worktrees`，按本机仓库标识分目录；这里不是同步目录，不支持跨机复制或多宿主共管。进程中断后，创建意图若未留下目录、登记或分支，可重新预览确认；有任何残留则人工核查，Kitto 不认领。清理意图若目录与登记均已消失且分支仍与记录一致，可重新预览并确认补记，不再调用 Git 删除。进程被终止后锁可能残留；先人工确认没有写者，不自动解锁。

本机锁只串行 Kitto 写操作，不能冻结宿主、Git 或外部文件系统。必须让目标树从确认到移除始终静止；绕过 Kitto 的并发写入与最后一次检查之间无法提供原子保证。不要将此流程用于 DSH 原生托管树或无法核实占用的远程/共享树。`audit` 仍是只读 Git 清单，不据此推断归属或占用。

### 宿主触发与双机验收

每次显式 `start` 预览同时给出本仓库、此设备私有台账中的 `handoffHints`：其他任务有登记、无登记、流程中断三类计数。`incomplete` 表示计数可能不全；无登记不等于空闲，中断不等于可重试，不扫描其他 checkout，也不暴露其任务或会话 ID。提示不进入执行决策，不修改占用。已知任务可从树外显式 `finish`，要只交接、保留树则预览 `--release` 并按上文确认；不认识的树只做 `audit`。

| 宿主 | 已知事件边界 | 本版 Kitto 行为 |
|---|---|---|
| Pi CLI | `session_start` / `session_shutdown` 会用于会话切换等流程；退出、reload、fork 都不是归档证明。 | 不安装监听；显式开工时提醒，显式交接时预览。 |
| Codex CLI | `SessionStart` / `SessionEnd` 不是 archive；app-server 的 thread archive/unarchive 不是 `hooks.json` 事件。 | 不安装 hook，不承诺从 SessionStart 切换 cwd。 |
| DSH Web / headless | `workspace/session-archived` 在归档持久化后发出 `{ sessionId }`；`workspace/session-unarchiving` 在取消归档持久化前发出同样的 payload。headless 一次运行结束不等于归档。 | 可选的 Web profile 工具读取权威归档集合；不订阅事件、不改 `retainOnArchive`、不收养原生树。headless 不主动提问，也不会因命令结束而写标记。 |
| DSH / Codex Desktop（本期范围） | 不假定 Desktop 提供相同插件和归档接口。 | 保持技能与手动预览；不接入 Desktop 状态。 |

**主动询问与归档待查不是同一件事。** 加载 `kitto-worktree` skill 的实时交互会话，在实际工作结束且尚未问过时，仅在交接回复里询问一次是否需要只读清理预览。不因每次输出、退出、归档或恢复而询问；拒绝后不动工作树。不向已归档会话写提问。

**DSH Web 归档待查（默认关闭）。** 已有 Kitto bundle 的同一用户 `web` profile，可在该 profile 的 patch 显式设置 Kitto 插件的 `config.archiveReview: true`，并与 Kitto CLI 使用同一私有 state 和 scope。例如给现有 row 增加 `- id: phyzess-kitto`，其下加入 `config: { archiveReview: true }`；按 DSH 的 patch 规则，若已有该 row 的其他配置，应一并保留。工具 `kitto_worktree_archive_review` 只在 `workspaceRegistry`、`sessionPersistence` 和 `tools` 均可用时注册。用 Kitto checkout 的**根目录**创建 DSH 会话，取得该原生会话 ID 后，在同任务上显式确认复用，并把**同一个 ID**登记为 `--session`；不要用猜测的 ID、workspace 名称或当前目录代替。之后可在另一个仍活跃的会话中明确要求按主仓库、任务 ID 和原生会话 ID 复核。只有宿主持久化会话的创建目录、仍有效的 Kitto claim 和工作树身份匹配，且 ID 目前确实在归档集合中，才输出 `review-pending`。它不是占用证明，也不授予清理权。

DSH 的 `workspaceRegistry.archivedSessionIds` 是待查事实的持久化来源；`sessionPersistence.list()` 提供会话头（`id`、创建时的 `cwd`）。证据见 DSH 0.2.2-rc.5 的 `@deepseek-ai/dsh-workspace/src/index.ts`（`archiveSession`、`unarchiveSession`、`archivedSessionIds`）和 `@deepseek-ai/dsh-session/src/types.ts`（`SessionHeader`）。读透权威状态避免在 Kitto 另写一份可能滞后的归档标记：重启仍可复核，取消归档后不再提示。没有服务、未开启、无法绑定或读取失败时，保持人工交接；不写 claim、不触发删除、不追加聊天消息，也没有常驻任务。没有验证原生 UI 的自动弹窗，本版不提供它。

1. 在两台机器各用独立的测试 clone、私有本机状态目录和一次性测试 scope；核对测试代码 SHA 相同。不要同步 Kitto 台账，不对日常工作树做清理测试。
2. 设备 A 为测试任务预览并确认开工；新会话使用不同 ID。退出、reload、fork，在可用的真实 UI 归档、解除归档，再次归档；在下一次显式 `start` 预览中，其他任务的登记不会因此减少。用相同任务的 `start` 预览核对 ID 仍在，同仓库另一个任务的预览只返回汇总计数。若有 DSH 原生树，仅观察它自身的行为，不对它调用 Kitto 的执行命令。
3. 设备 B 对相同任务 ID 预览；不能复用 A 的 checkout 或看到 A 的提示。只有显式确认才会建立 B 自己的树。两台设备分别从树外核实会话和进程后，预览 `--release`；不确认时既不释放也不删。需要测试最终移除时，仅在一次性树确认后执行并核对分支仍在。

事件边界基于 Pi 1.5.2、Codex 0.170.0 与 DSH Web 0.2.2-rc.5 的文档或代码核验。原生契约测试以隔离 Git 仓库、存储夹具和 DSH 实际注册表/工具 SDK 加载适配入口，验证重复归档、重启恢复、取消归档及在读取期间取消归档；不启动用户的 Web UI、不改真实 profile。真实 UI 的对话效果、headless 会话和第二设备尚待验。

## 共享工作区

如果只需登记一个已有工作区，运行 `npx --yes @phyzess/kitto setup --workspace /path/to/workspace`。目录可以已经有多个独立 Git 仓库。Kitto 会保留已有的规则与 skill，创建缺少的目录和规则文件，并为当前账号能运行的宿主安装适配器。加 `--dry-run` 可以预览，`--agents pi,codex` 可选定宿主。

```text
workspace/
├── AGENTS.md
├── .agents/skills/review/SKILL.md
├── repo-a/AGENTS.md
└── repo-b/
```

例如在工作区的 `AGENTS.md` 写「改代码后运行当前 repo 的测试」。在 `repo-a/AGENTS.md` 写「测试命令为 make check」。新会话能看到两条规则；在 `repo-b` 中只有工作区的通用约定。以后新 clone 的 repo 自动按会话的工作目录加入这个范围。DSH Web 使用所选项目的会话目录，服务启动目录可以在其他位置。

共享 skill 使用三个宿主通用的目录格式。例如 `.agents/skills/review/SKILL.md` 可以写成：

```markdown
---
name: review
description: 审查当前仓库的代码修改。
---

读当前 Git diff，按影响列出需要修正的问题，并指出缺少的回归测试。
```

打开新会话并说「使用 review 审查这个修改」。Pi 和 DSH 使用原生 skill 发现。Codex 通过 SessionStart hook 把工作区 skill 的说明和路径交给模型，原生 `/skills` 菜单仅列出 Codex 自己发现的条目。首次在 Codex 用 `/hooks` 信任 Kitto 的 hook；DSH 在重启对应 profile 后加载适配器（`desktop` 配置档由 App 管理，没有 scope adapter）。

`setup --global` 的文件位于 Kitto 数据目录的 `global/AGENTS.md` 和 `global/.agents/skills/`。默认数据目录为 `~/.local/share/kitto`。全局与工作区可以叠加，已登记的多层工作区按从外到内的顺序加载规则。同名 skill 的选择沿用各宿主的发现机制，给不同流程使用不同名称即可跨宿主一致引用。个人宿主扩展、模型和项目本身的设置继续使用各自的配置。

### DSH 使用独立服务账号

如果 Pi、Codex 在当前账号下运行，DSH Web 则由另一账号的 Linux systemd 系统服务启动，可以在有权限的 root 终端指定服务一次：

```bash
npx --yes @phyzess/kitto setup --workspace /home/dsh/workspace --dsh-service dsh.service
```

这会把同一工作区登记到两个账号。服务账号需要能访问工作区，命令从正在运行的服务取得宿主环境。正式应用后，在合适的时候重启该服务，再在 Web 中选 repo。每个项目继续使用同一套工作区文件。

### DSH Desktop 配置档（v1：仅全局规则与 skills）

DeepSeek Harness Desktop 独占 `desktop` 配置档：npm 版 `dsh` CLI 会拒绝管理它，只有 Desktop 内置的 `dsh` 命令可以。Kitto v1 对 `desktop` 采用 **global-only** 模式，只部署全局规则和 skills：

1. 启动一次 DeepSeek Harness Desktop，让 App 初始化 `$DSH_HOME/profiles/desktop`。Kitto **不要求**本机安装 `dsh` CLI，也不会用 npm 补装它（`--install-agents` 不会为 desktop 安装 npm 版 dsh）；没有 CLI 时只是跳过对 profile 的探测。若希望启用探测，可在 Desktop 菜单「Manage dsh Command…」安装内置命令，但装不装都不影响全局规则/skills 部署。
2. **完全退出** Desktop（不是最小化），避免 App 持有 profile 锁。
3. 运行（向导里输入配置档时直接填 `desktop` 也可以）：

   ```bash
   npx --yes @phyzess/kitto setup --agents dsh --dsh-profile desktop
   ```

4. 重新打开 Desktop，加载 `$DSH_HOME/AGENTS.md`、`$DSH_HOME/skills` 和共享的 `~/.agents/skills`。

Kitto v1 对 `desktop` 能做：

- 部署全局 `AGENTS.md`、DSH 专属 skills 和共享 skills；
- 用临时 `DSH_HOME` 副本做 best-effort 探测（不写真实 profile）：manifest 不存在时直接跳过，有 manifest 时区分 npm CLI、Desktop 内置 CLI 和超时/不可用，并给出提示；
- 不要求 pnpm 或本机 dsh CLI；移除集成时不调用 `dsh plugin remove`（因为从未安装 bundle）。

Kitto v1 对 `desktop` 不做：

- 不安装 Kitto bundle，不写 `profiles/desktop/cordis.patch.yml`，不注册 scope adapter，也不同步 DSH MCP home patch；
- 不改 Desktop 应用的 `package.json`、lockfile 或 profile 依赖；
- 不把 `desktop` 用于 `--global` / `--workspace` / `--workspace-parent` 的 scoped 配置或 `--dsh-service`：只选 dsh 时会明确报错，与其他宿主混选时跳过 dsh 并配置其余宿主；
- 向导里的「仅配置共享规则与 skills」不能用于 desktop（没有配置来源就无全局规则可部署）。

Desktop 内置的 `dsh` 命令只管理 App 自己的 profile，**不能**让 Kitto 获得 bundle、scoped 规则或 MCP 同步。需要这些能力时只能改用 `--dsh-profile web`（或 headless 等 Kitto 管理的 profile）。Desktop 更新可能改变其读取全局规则/skills 的方式，升级后请重新验证。

Desktop 的深度支持（受控写 `profiles/desktop/cordis.patch.yml` 中的 Kitto 行、检测/使用内置 CLI、bundle/package/lockfile 边界）仍暂缓，只记录在 [DSH Desktop roadmap](roadmap.md) 中；v1 不实现，也不构成版本承诺。

从 `desktop` 切到 `web`（或反向）时，Kitto 要求先解除当前集成：通过维护 skill 运行 `maintain remove --apply`，再用新的 `--dsh-profile` 执行 setup；未解除时 setup 会拒绝切换 profile。

## 查看与移除 scope 登记

`setup` 只会把 global、工作区和父目录登记到 Kitto 数据目录的 `scopes.json`（默认 `~/.local/share/kitto/scopes.json`）。下面的命令只读写这份登记，不安装或修改宿主：

```bash
npx --yes @phyzess/kitto scope list
npx --yes @phyzess/kitto scope list --json
npx --yes @phyzess/kitto scope remove --global
npx --yes @phyzess/kitto scope remove --workspace /path/to/workspace
npx --yes @phyzess/kitto scope remove --workspace-parent /path/to/workspaces
```

`scope list` 只读；文件不存在时按空登记处理，不会创建文件。`--json` 输出 `version`、`global`、`workspaces`、`workspaceParents`，并保留文件中的未知顶层字段，方便脚本读取。

`scope remove` 只移除登记，**不删除**任何 `AGENTS.md`、`.agents/skills`、宿主 hook/symlink/profile patch 或用户文件。要解除宿主集成，仍使用「用 Kitto 预览解除集成」。路径先按当前目录解析为绝对路径，并像 setup 一样优先尝试 realpath（路径不存在时保留解析结果），因此也可以用符号链接路径移除。要移除的项不存在时命令以退出码 1 失败且不写文件；`--global` 在全局未登记时同样失败。移除与 setup 共用数据目录下的 `.scope-setup.lock`，setup 正在运行时命令会报错退出，避免并发覆盖登记。写回使用临时文件加 rename，文件权限为 0600。

## 选择 agent

交互向导默认选中检测到的宿主。下面的显式参数用于非交互部署配置仓库。只想配置 Codex 时，在安装命令末尾加 `--agents codex`。如果新机还没有 Codex，加 `--agents codex --install-agents` 即可一起安装。多个宿主用逗号分隔，例如 `--agents pi,codex`。再次 setup 可以追加宿主。

| 宿主 | Kitto 管理的内容 | 使用前准备 |
|---|---|---|
| Pi | settings、MCP、扩展、规则和 skills | 通过 Kitto 安装 Pi CLI 需要 Node 22.19+ |
| Codex | 全局规则、skills、Kitto 插件，以及 Pi 源中启用 MCP 的白名单同步 | 登录 Codex，按需配置自己的模型和权限 |
| DSH | 全局规则、skills、指定 profile 的 Kitto bundle、白名单 MCP 同步，以及 CodeGraph 索引提醒/初始化（`desktop` 仅全局规则与 skills） | pnpm（web/headless）。通过 Kitto 安装 DSH CLI 需要 Node 24.9+；`--install-agents` 可补装 pnpm。Desktop 配置档由 App 管理，不需要 pnpm |

DSH 默认使用 `web`。已有其他 profile 时，首次 setup 加 `--dsh-profile <name>`，以后按该 profile 的原生方式启动。`desktop` 由 Desktop 应用管理，只支持全局规则与 skills，见上文「DSH Desktop 配置档」。

### 当前能力矩阵

| 能力 | Pi（macOS/Linux） | Codex | DSH（Linux；macOS 同一套规则） |
|---|---|---|---|
| 全局规则 | `common.md` + Pi addendum 组合后整份写入 `$PI_CODING_AGENT_DIR/AGENTS.md`（默认 `~/.pi/agent/AGENTS.md`） | `common.md` + Codex addendum（Kitto 标记块） | `common.md` + DSH addendum（Kitto 标记块） |
| 共享 skills | `~/.agents/skills` | `~/.agents/skills` + SessionStart hook | `~/.agents/skills`（`desktop` 无 scope provider） |
| 宿主专属 skills | Pi 上游包 | `config/codex/skills` 副本 | `config/dsh/skills` 副本 |
| 插件/扩展 | Pi 包、Pi 扩展 | Kitto Codex 插件 | Kitto DSH bundle（web/headless；`desktop` 无） |
| MCP | 共享 + 平台 + private + 项目级 | Kitto 同步白名单 server；HTTP `Authorization: Bearer ${VAR}` 转为 `--bearer-token-env-var` | Kitto 同步白名单 server；env/headers 的 `${VAR}` 转为 credential 模板（`desktop` 不同步） |
| 模型/settings | Kitto 管理 | 宿主自管 | 宿主自管 |
| 凭据/env | `~/.pi-agent-env` | HTTP bearer 环境变量引用；其余宿主自管 | `${credential:VAR}` 模板 + `expandTemplates`；其余宿主 env/service env |
| workspace scope | scoped-pi | scoped-codex | scoped-dsh（web/headless；`desktop` 无） |

`desktop` 是唯一的例外：它由 Desktop 应用独占，Kitto v1 只部署全局规则和 skills，不安装 bundle、不写 profile patch、不注册 scope adapter，也不同步 MCP home patch。

MCP：Pi 由 Kitto 管理共享、平台、private 和项目级条目。DSH 在 `setup` 和 `sync` 时由 Kitto 把 `config/pi/mcp.json`（叠加当前平台的 `config/pi/platform/<macos|linux>/mcp.json`，跳过 `enabled: false`）中的 server 同步为 `$DSH_HOME/cordis.patch.yml` 里的 `kitto-mcp-*` 条目；home patch 对所有 profile 生效，同步只增删这些条目，保留其它 YAML 行、注释和 `!!js`，Kitto 自己的条目按源顺序追加到末尾。

凭据只接受引用：stdio `env` 和 HTTP `headers` 的值必须是完整的 `${VAR}`；`Authorization` 还可以写 `Bearer ${VAR}`。DSH 把引用映射为 mcp-client 的 `${credential:VAR}` 模板，并在该行设置 `expandTemplates: true`，由 DSH 的 credentials provider 在运行时解析（优先级：`$DSH_HOME/.credentials.yaml` > 进程环境 > 启动目录 `.env` > `$DSH_HOME/.env`）。secret 不写入 host patch，也不出现在 Kitto 日志里；引用未配置时该 server 会等待凭据，而不会拿到字面 token。字面值、字面 token 形状、`${VAR}` 与其他文本拼合、以及出现在 `url`/`command`/`args` 里的模板都会整条 skip，原因只包含键名或 token 类型。`url` 带 userinfo（`user:pass@host`）或 token/key/secret/password/sig/signature/auth 类 query/fragment，以及 `command`/`args` 中带凭据形状的 flag（含 `--header`/`-H` 后跟敏感 header 名或凭据值）、env 赋值或字面 Authorization 也会被拒绝。该映射要求 mcp-client 支持 credential 模板（DSH `0.2.2-rc.2` 起；实测 `0.2.2-rc.5`）；Kitto 的 DSH 基线与 `engines` 已提升到 `0.2.2-rc.2`，setup 会用带 prerelease 比较的版本检查拒绝 rc.1，`--install-agents` 固定安装 rc.2（已装更新的版本仍可通过检查）。Kitto 不生成 `!!js process.env.VAR` 作为回退，因为 `!!js` 会在 host 启动时执行配置表达式，暴露面比只允许 `${credential:...}` 的模板更大。

默认只读 Pi 的 base 与 platform。机器专属的 `config/pi/mcp.private.json`（Git 忽略）和 `config/pi/local/mcp.json` 默认不读取；全局 `setup` 或 `update` 加 `--include-private` 才会纳入，叠加顺序为 base < platform < local < private，两个文件都可选。该选择记录在 `state.json`：之后不带参数的 `setup` 会沿用，`--no-include-private` 关闭；scoped setup 不处理 MCP，因此拒绝这两个参数。仍含 `YOUR_*` 占位符的条目也会跳过，避免把模板 URL 同步出去。

home patch、`profiles/*/cordis.patch.yml` 或已启用的 `mcp-manager` `servers` 已声明同名 server 时，跳过并警告。非空 flow 风格顶层 patch、`kitto-mcp-*` 与其它条目混在同一 `insert`、或生成结果无法解析（例如删除后留下未解析 alias）时会中止且不写入。设置 `KITTO_NO_MCP_SYNC=1` 可关闭同步；`maintain remove` 会删除 Kitto 自有条目。同步成功后，Kitto 会在所有权台账（`owned.mcp.dsh`）记录每一行的指纹；之后若某个 `kitto-mcp-*` 行与记录的指纹不一致（被本机改过），同步和 `maintain remove` 都会保留该行并警告（与 Codex 的策略一致）。没有台账记录的行（迁移前的安装）仍只按 `kitto-mcp-` 命名空间处理，下一次成功同步后才会补记。`desktop` 配置档不参与 MCP 同步（也不写 home patch）。Codex 的 MCP 由 Kitto 同步（见下），模型/settings 和凭据继续使用各自原生配置。

Codex 的启用 server 同样从该 Pi 源派生（默认 base+platform，`--include-private` 的开关与 DSH 相同）。同步传递 stdio 的 command/args 或 HTTP 的 URL；HTTP server 若只带一个 `Authorization: Bearer ${VAR}` header，会映射为 `codex mcp add ... --url ... --bearer-token-env-var VAR`，Codex 只保存环境变量名，明文 secret 不进入 `config.toml` 或 argv。其他 headers、stdio 的 `env`、`env_http_headers` 和 `bearer_token_env_var` 字段不能由 `codex mcp add` 安全表达，包含这些字段的 server 会整条跳过并打印原因；含字面 token 形状、`url`/`command`/`args` 模板、URL userinfo/凭据类 query，或 `command`/`args` 中凭据形状 flag（含 `--header`/`-H` 后跟敏感 header 名或凭据值）、env 赋值或字面 Authorization 的 server 同样拒绝；原生 Codex 失败信息不回显 argv。模型/settings 和凭据继续使用各自的原生配置。共享层只保证规则、skills 和 scope 语义一致。

Codex 的 MCP 归属记录在 `state.json` 的所有权台账（`owned.mcp.codex`，schema 2；旧版的 `mcp.codex`/`mcp.codexPending` 在首次写入时迁移到台账）：只有带有 Kitto 指纹且 live 配置未被改动的 server 才会被更新或删除。写入前，Kitto 先把目标指纹记为 pending；`codex mcp add` 成功并通过重新 list 校验后才转为正式归属。若进程在 live 写入后、state 保存前中断，下次 sync 会直接收养（`mcp adopt`），不会留下永久无归属的 server。verified list 确认 owned server 已从 live 消失时，Kitto 会清除旧指纹（`mcp forget`），避免之后误删同名同 transport 的用户 server。若中断的 add 只留下 pending、随后源条目被删除，pending 对应的 live server 会被移除；没有 live 或 transport 已被改动的 pending 会被清理（`mcp forget pending`）。同名但不是 Kitto 添加的 server、以及被本机修改过的 server（包括额外 env、headers、工具过滤或超时）都会保留，并在 `status`/`sync` 计划中标记为 `mcp conflict`。

Codex MCP 的已知边界：

1. 源文件必需：Kitto 从 `config/pi/mcp.json` 加当前平台覆盖生成计划；即使只选 Codex，缺少这个文件也会让 setup 明确失败。
2. 凭据和语义字段的边界：唯一会写入 Codex 的凭据是 HTTP 的单 `Authorization: Bearer ${VAR}`，它映射为 `--bearer-token-env-var VAR`（归属指纹记录变量名，不记录值）。stdio `env`、其他 headers、`env_http_headers`、`bearer_token_env_var` 字段，以及 Pi 源中的 `oauth`、`scopes`、`tools`/`toolFilter`、`timeout` 等字段不会写入 Codex。包含这些字段的 server 会整条跳过并打印原因，相关能力继续在 Codex 原生配置中维护。Pi 专用的 `lifecycle`、`directTools` 等展示/生命周期字段会被忽略。
3. `--url` 与 OAuth：Codex 0.170 的 `mcp add --url` 会先写 `config.toml`，再做认证发现；对需要 OAuth 的 URL，首次 add 可能等待约 30 秒后超时。Kitto 在写前已记录 pending；若超时/失败后 list 能看到 transport 完全一致且没有额外设置的 server，会立即 `mcp adopt` 并打印警告（提示 `codex mcp login <NAME>`），不会把 transport 不同的用户 server 误判为 Kitto 的；否则保留 pending，下次 sync 重试。认证本身仍需在 Codex 中完成。
4. Codex 原生字段不由 Kitto 写入：`startup_timeout_sec`、`tool_timeout_sec`、`enabled_tools`/`disabled_tools` 等如果出现在 live 中，会视为本机修改并保留，不会被覆盖。
5. TOML 重写：`codex mcp add/remove` 会重写配置，可能丢失注释（尤其是被操作的 `mcp_servers` 表及其邻近注释，更新已有 server 时文件顶部注释也可能消失）并调整 mcp 表顺序；Kitto 不直接写 TOML，只在 transport 有差异时调用原生命令。
6. `kitto remove` 预览与 `versions` 仍调用真实 Codex 读取插件/版本清单；Codex 可能在 `CODEX_HOME/tmp` 下创建 arg0 辅助文件，但不会修改 `config.toml`。`status`、`sync` 和 `setup --dry-run` 的 MCP 探测已使用临时 home。

`kitto status` 会用 `mcp pi/codex/dsh` 和 `mcp missing on …` 列出各宿主实际加载的 MCP 名称；它只读，不写任何宿主配置。`desktop` 配置档显示为 `mcp dsh: (global-only; MCP sync disabled)`，不参与缺失比较。读取 Codex MCP 时使用临时 `CODEX_HOME` 副本，不会在真实 Codex 目录下产生辅助文件。

### 一键迁移仍需要手动做的事

`setup` 会部署规则、skills、宿主注册和依赖检查，但以下项目按宿主/账号不同，必须手动完成：

1. 安装并登录各宿主 CLI（或用 `--install-agents` 只补装 CLI）。
2. Pi：复制 `config/pi/mcp.private.json` 并填写 host/token；把 `~/.pi-agent-env` 放进 shell 启动文件。若希望 DSH/Codex 也同步这些引用式私有 server，给全局 setup/update 加 `--include-private`。
3. Codex：首次在 `/hooks` 信任 Kitto 的 SessionStart hook。
4. DSH：重启对应 profile/服务；Desktop 用户完全退出并重新打开 App（Kitto 只部署其全局规则/skills）；DSH 中未使用引用式 env/headers 的私有 MCP、旧版 DSH 不支持的 credential 模板，以及 Codex 无法表达的 stdio env / 非 Authorization header，仍需在对应宿主原生配置中手动添加。
5. 需要 CodeGraph 的仓库：在仓库根目录执行一次 `codegraph init`（Kitto 会提醒）。


## 规则共享层与宿主 addendum

三个宿主的共同工作规则在 [config/instructions/common.md](../config/instructions/common.md)：语言、只读审查、保留改动、发布/外部消息/不可逆操作确认、验证、工具可用性/CodeGraph、会话开始加载 `i-have-adhd` 和 `hindsight` 等。`config/<宿主>/AGENTS.md` 只放该宿主的 addendum，例如 Pi 的 MCP 工具表、浏览器和 Plannotator 约定，Codex/DSH 的 skill 回退路径。Pi 配置目录默认 `~/.pi/agent`，可由 `PI_CODING_AGENT_DIR` 覆盖；Codex/DSH 路径分别由 `CODEX_HOME`、`DSH_HOME` 控制。

Kitto 部署时直接按文件拼接组合，不使用模板。共享段与宿主段之间固定插入一行 `<!-- kitto:host-addendum -->` 作为分隔哨兵，push 依赖它切分并校验两段：

| 宿主 | 部署结果 |
|---|---|
| Pi | `common.md` + `config/pi/AGENTS.md` 整份写入 `$PI_CODING_AGENT_DIR/AGENTS.md`（默认 `~/.pi/agent/AGENTS.md`），该文件仍由 Kitto 整份管理 |
| Codex | `common.md` + `config/codex/AGENTS.md` 写入 `$CODEX_HOME/AGENTS.md` 的 Kitto 标记块 |
| DSH | `common.md` + `config/dsh/AGENTS.md` 写入 `$DSH_HOME/AGENTS.md` 的 Kitto 标记块 |

Codex/DSH 只替换标记块，块外内容保持本机所有；块内被手工修改时 sync 会报错并保留文件。Pi 在 pull 时按组合结果整份对比，内容不同才覆盖。维护命令 `export` 只把 `$PI_CODING_AGENT_DIR/AGENTS.md` 里的 Pi 专属段导出回 `config/pi/AGENTS.md`：共享规则必须在本仓库的 `common.md` 修改；本机文件缺少分隔哨兵、共享段与当前 `common.md` 不完全一致，或组合结果不规范（例如整段删除共享规则但本机尚未 pull）时，push 会在写仓库前拒绝导出。

只改这台机器的规则写在 Codex/DSH 标记块外，或使用工作区/仓库自己的 `AGENTS.md`；不要直接编辑 Pi 的全局 `AGENTS.md`，它会在下次 pull 时被整份重写。配置源缺少 `config/instructions/common.md` 时 setup/sync 会直接报错，不再有整文件回退；先把配置源更新到含共享层的版本。

## i-have-adhd 回复风格

使用本仓库的完整配置后，Pi、Codex 和 DSH 默认采用行动优先、分步呈现的回复风格。Pi 通过上游扩展启用常开模式；三个宿主共享的 `common.md` 在会话开始要求加载同一版本的 skill。DSH 的 `i-have-adhd` 副本可由模型加载，AGENTS.md 会在会话开始要求加载它。向导的「仅配置共享规则与 skills」选项会跳过配置仓库里的这些内容。

在会话中输入 `normal mode` 或 `stop adhd mode` 即可恢复普通风格。需要重新启用时，Pi 输入 `/i-have-adhd`，Codex 和 DSH 可以说「使用 i-have-adhd」。维护时，Pi 包版本与两个宿主的 skill 副本应一起更新。 [上游固定版本](https://github.com/ayghri/i-have-adhd/tree/1ecea1993b7fce257ffbd686c070948b5e07eda6)

## 配置改在哪里

| 想改变什么 | 改哪里 |
|---|---|
| 多个 agent 共用的工作方法 | 仓库的 [skills/](../skills/) |
| 三个宿主共用的工作规则 | [config/instructions/common.md](../config/instructions/common.md) |
| 某一个 agent 的规则或专属 skill | 对应宿主的 `AGENTS.md` addendum（只放宿主专属内容）或 `skills/` |
| 某项能力用到的工具和版本 | [config/dependencies.json](../config/dependencies.json) |
| 只在本机生效的规则 | Codex 或 DSH 全局 `AGENTS.md` 的 Kitto 区块之外；Pi 使用工作区/仓库自己的 `AGENTS.md` |

默认配置来源是这个 GitHub 仓库。使用自己的 fork 时，首次 setup 加 `--source <Git-URL>`；要复用已有仓库，则传入本地路径。让 Kitto “检查配置状态”可以看到本机使用的源目录。共享 skills 默认由 Kitto 部署到 `~/.agents/skills/`。

Pi 适配器是 Kitto 进程内的 JavaScript 模块（`lib/pi-adapter.ts`），没有单独的 shell 入口；共享 skills（`~/.agents/skills`）由 Kitto JS 按 hash 所有权和锁管理。`AGENTS.md` 仍走共享层组合；`push` 只导出 Pi 专属段，详见上文「规则共享层与宿主 addendum」。需要同步时使用 `setup`，或在会话里让 Kitto 维护 skill 执行 sync。`setup.sh --force` 同样已废弃：它只打印一次警告，并按旧的非交互语义运行 setup（不会启动向导）。

## 换机与更新

在第一台机器上，告诉 Kitto 这次修改适用于哪些机器和 agent。检查配置仓库中的差异，提交并推送。到第二台机器，用一条命令更新配置源、已安装的 Kitto 程序和部署：

```bash
npx --yes @phyzess/kitto@latest update          # 预览：远端提交、runtime 与部署计划，不写入
npx --yes @phyzess/kitto@latest update --apply  # 拉取配置、刷新 runtime、部署
```

`update` 默认只预览（`--check` 是同一预览的显式写法），不写任何文件；`--apply` 依次做三件事：

1. **配置源**：只对干净的分支执行 `git fetch` + `git pull --ff-only`；本地与远端只要有一方是另一方的祖先就继续（本地领先时等同于 Already up to date），只有真正分叉（互不为祖先）才拒绝且不合并。本地修改会中止且不会 stash 或 reset；detached 或 tag 固定的 checkout 会提示改用 `setup --ref TAG`。Kitto 创建的 checkout 会记录 `sourceUrl` 和 `sourceRef`（分支名或 tag 名），checkout 丢失时按记录的 ref 重新 clone；tag 固定、ref 无法确定或远端已无该分支时不会猜测，而是提示在原地重建 checkout 后重跑 `setup`，或换一个 `KITTO_HOME`。origin 变化时会同步更新 `sourceUrl`（日志中的凭据已脱敏）。旧版 `state.json` 没有这些字段也能运行，存在 bootstrap marker 时会自动回填。
2. **已安装 runtime**：把正在执行的 Kitto 包（`bin`、`lib`、`integration`、`package.json`、`CHANGELOG.md`）替换到 `~/.local/share/kitto/runtime`。替换前把上一次验证过的版本保存为 `runtime.previous` 检查点。新 runtime 在本次部署成功前只是 `pendingRuntime`，不会成为检查点，也不会覆盖 `state.json` 里的已验证版本；部署失败时 `setup --recover` 仍回到上次成功部署的版本，重试也不会把未经验证的代码当成检查点。
3. **部署**：规则/指令、skills、MCP 与 Pi 配置沿用原有 `sync` 逻辑；原生插件/扩展注册保持不变（仍指向 runtime 路径，无需重装）。预览不写文件。

### 工具 Node 与 `kitto-node` 启动器

Kitto 要求 Node 26+。agent 在项目目录里直接运行 `node` 时，mise/nvm 可能给出项目固定的旧版本，所以 Kitto 自己的命令（维护 runner、`kitto route`、`context-budget` 与 `jev-decide` 的脚本）都经 `~/.agents/bin/kitto-node` 运行。setup、`update --apply` 与 `sync --apply` 会选出一个与项目无关的 Node 并写入 `state.json` 的 `toolNode`：优先 mise 全局（在 `$HOME` 下运行 `mise which node`，有主版本号符号链接时用它），否则用运行 setup 的 Node。`status` 与预览会打印它，预览不写入。记录的 Node 被卸载后启动器会提示重新运行 `kitto setup` 并以 127 退出。该路径上的外来文件会被保留并警告，`kitto remove` 只删除 Kitto 自己写的启动器。设计见 [ADR 009](adr/009-tool-node-and-launcher.md)。

### 宿主 CLI：只升到已验证基线，不自动更新

`update` 不会升级 Pi、Codex 或 DSH 的宿主 CLI，也不会在后台检查新版本。宿主升级是单独、显式的动作，目标只取 Kitto 已验证的基线（即代码中的 `hosts[name].version`），不追 npm `latest`，也不使用 `npx` 临时运行：

```bash
npx --yes @phyzess/kitto@latest hosts          # 只读：当前版本、Kitto 基线、原生升级命令
npx --yes @phyzess/kitto@latest hosts --check  # 同上，显式写法
npx --yes @phyzess/kitto@latest hosts --apply  # 只把低于基线的已选宿主升到基线
npx --yes @phyzess/kitto@latest hosts --host codex --version 0.170.0 --apply
```

`kitto hosts` 只处理 `state.json` 中已选的宿主，逐行显示当前 `--version`、Kitto 基线 `hosts[name].version` 和对应的原生管理命令。`--check`（默认行为）只读：不写宿主、不写 Kitto 状态；`--apply` 才执行 `npm install --global <包>@<版本>`。Pi 和 Codex 安装各自的 npm 全局包；DSH 安装 `@deepseek-ai/dsh@<基线>`，基线是 prerelease 时保留精确版本（例如 `0.2.2-rc.2`），不会替换成 `next` 或 `latest`。

- 版本低于基线或尚未安装：`--apply` 安装基线。
- 已等于基线：不做任何事。
- 高于基线：默认不降级；确实需要时用 `--version` 明确固定，并会提示该版本不是已验证基线。
- `--version` 只接受精确版本号（拒绝 `latest` 等 dist-tag 和版本范围），且只能作用于一个宿主：多选宿主时配合 `--host NAME`。它是显式覆盖，不是已验证基线；`--check` 和 `--apply` 都会警告该版本未经 Kitto 验证。
- 未选中的宿主不会被探测或升级；`desktop` 配置档的 DSH 由 Desktop App 管理，Kitto 不安装或固定其 CLI，请使用 App 升级。
- 若 npm 不可用、宿主版本无法读取，或安装后的版本与目标不一致，命令会明确失败；失败不会写 `state.json`。
- 升级完成后重启对应宿主，让新 CLI 生效。

### 宿主版本不是 setup 的前置条件

`setup` 和 `update` 不会因为某个宿主的 CLI 低于基线而中止，也不会让一个过期的宿主挡住其他宿主：

- 版本低于基线时打印警告，继续部署规则、skills 和其余宿主；该 CLI 缺少的子命令（例如旧 Codex 没有 `plugin`）会被逐项探测，只跳过对应的原生注册，并说明跳过了什么。
- 读了版本号但无法解析、或 `--version` 失败时，同样只是警告，并把该宿主的原生集成标记为未验证。
- 二进制不存在仍然是错误（`--install-agents` 可补装），因为此时没有任何可部署的路径。
- 需要发布验证那种严格语义时，给 `setup`/`update` 加 `--require-baseline`：低于基线恢复为致命错误，且在任何写入之前失败。

基线因此只是「Kitto 验证过的版本」和 `kitto hosts --apply` 的安装目标，不再是写入前提。

需要复现某次配置时，在 setup 命令末尾加 `--ref <已存在的-tag>`。Kitto 创建的配置仓库可以用同一参数切换到另一个 tag；自己提供的本地仓库用 Git 切换。状态中的 `deployed` 表示上次成功部署的提交，`checkout` 表示源目录当前的提交。检查上游工具版本时，可以直接说“用 Kitto 在线检查已启用工具的版本”。

## CodeGraph 索引与工作区权限

DSH 的 CodeGraph MCP 只查询已经建立索引的仓库。Kitto 在 `status` 中报告缺失的索引，并在 scoped `setup` 登记工作区后对其执行 `codegraph init`；这要求 `codegraph` 在 PATH 中。普通 `sync`、`deps`、`export` 不写索引。设置 `KITTO_NO_CODEGRAPH_INIT=1` 可以只提醒、不自动执行。

Kitto 也会检查已登记工作区是否对当前账号可写。只读工作区会让 agent 无法创建 `.codegraph`、`.pi` 或修改文件；setup 会打印警告。按提示给运行 DSH 的账号授予写权限（`chown` 或 `setfacl`）后重试。

## 安装失败或需要恢复

首次 setup 遇到配置冲突时，修正冲突后重跑原命令。加 `--dry-run` 可先看操作预览；对于尚未下载的远端配置，预览仅显示安装步骤。

如果升级后维护 skill 无法运行，在首页的安装命令末尾加 `--recover --dry-run` 查看恢复计划，再用 `--recover` 执行。恢复会切回之前验证过的 Kitto 程序并重新连接宿主。个人配置的历史版本通过 Git 恢复。

### 所有权台账与降级

`state.json` 自 schema 2 起用一份所有权台账（`owned`）记录 Kitto 创建的 skills、指令块、MCP 行和 Pi 包，取代原来的 `skills`、`hostSkills`、`keptSkills`、`instructions`、`mcp.codex`、`mcp.codexPending` 和 `config/pi/local/managed-packages.json`。升级后第一次真正写入（`setup`、`update --apply`、`maintain` 的 `--apply` 操作和 `setup --recover`）会迁移旧状态，并在 `state.json` 旁一次性保存原始内容 `state.v1.json`（不会被覆盖）；`status`、`--dry-run` 和预览只在内存中迁移，不写任何文件。迁移导入的 `managed-packages.json` 会在一次成功的 apply 之后删除。

schema 2 的 `state.json` 不能被旧版 Kitto 读取。降级 Kitto 包之前，先运行：

```sh
kitto maintain state-rollback            # 预览，不写入
kitto maintain state-rollback --apply    # 把 state.json 写回 schema 1，并恢复 managed-packages.json
```

账本里有 schema 1 无法表达的条目（例如未完成的 skill 写入）时命令会拒绝并说明原因，不改动任何文件。DSH 行的指纹在 schema 1 里本来就不存在，回滚时丢弃，不影响旧版的命名空间识别。兜底做法是把 `state.v1.json` 复制回 `state.json`，但这会丢失迁移之后的变更。

### 被中断的运行、残留锁与未验证的 runtime

`setup`/`update` 的写入由 `$KITTO_HOME/.lock` 串行化，Pi 适配器另有一把 `<配置源>/config/pi/local/.sync-lock`。两把锁都记录持有者（`owner.json` 或 `pid` 文件），所以续跑时能直接判断持有者是否还在：

- 持有者仍在运行：报 `Another Kitto operation holds …: pid N started …`，等它结束再重试。
- 持有者已退出：报这是 `stale lock` 并给出 pid；加 `--break-lock` 重跑即可清除。它**只清理可证明已退出的锁**，进程还活着时一律拒绝。
- 旧版 Kitto 留下的锁没有 owner 记录，`--break-lock` 不碰，需要人工确认后删除。

正常退出以及 `SIGINT`/`SIGTERM` 都会释放锁，只有 `SIGKILL` 或断电才会留下残留。部署中途失败时 runtime 会停在未验证状态（`state.json` 的 `pendingRuntime`）：重跑同一条 `update --apply` 完成，或用 `setup --recover` 回到上一份已验证的 runtime，命令会直接提示。

需要解除集成时，可以在 agent 里说“用 Kitto 预览解除集成”。解除 DSH 时会同时删除 `$DSH_HOME/cordis.patch.yml` 中 Kitto 自有的 `kitto-mcp-*` 行，保留其它内容；patch 无法安全解析时保留文件并警告，不阻塞解除。解除后仍保留个人配置、共享 skills 和宿主 CLI。

## 发布新版本

1. 在同一个 PR 里更新 `package.json`、`package-lock.json` 和 `integration/plugin.json` 的 `version`，并在 `CHANGELOG.md` 顶部新增对应小节，例如 `## 0.2.1`。发布脚本接受 `主版本.次版本.补丁版本` 格式的正式版本。
2. 等 PR 合入、CI 通过，在干净的工作树上切到最新的 `origin/main`。使用与 CI 一致的 Node.js 26，版本记录在 [`.node-version`](../.node-version)。还需要 npm、Git 和 Bash（检查 `setup.sh` 语法）。正式发布时，当前账号需要能向 `origin` 推送 tag，并能向 npm 发布 `@phyzess/kitto`。
3. 在仓库根目录执行下面的命令。第一条从提交快照运行检查并生成临时 npm 包，第二条重复检查，随后推送 `v0.2.1` 并把同一份包发布到 npm `latest`。

   ```bash
   npm run release -- 0.2.1
   npm run release -- 0.2.1 --publish
   ```

如果 tag 已推送、npm 发布中断，回到同一个提交并用同一工具链重跑第二条。远端 tag 指向同一提交时可以继续发布。npm 上已有同版本时，脚本核对包的完整性摘要，吻合便视为已发布。

发布后的校验会轮询 registry（最多 24 次、每次 15 秒，约 6 分钟），因为 npm 确认 publish 之后还需要一段时间才对外提供该版本；只读一次会把成功的发布误报成 `Cannot verify`。拿到与本地 tarball 相同的 `dist.integrity` 即通过，读到不同的摘要则立刻失败。

需要让某台机器复现这一版时，可以把程序和配置都固定到该版本：

```bash
npx --yes @phyzess/kitto@0.2.1 setup --ref v0.2.1
```
