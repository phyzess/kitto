# 配置与同步

[返回首页](../README.md)

## 一次设置，自动发现之后新建的工作区

在终端运行 `npx --yes @phyzess/kitto@latest setup`（已有源码时可运行 `./setup.sh`）。选择宿主、配置来源和可选依赖，在「工作区父目录」填入存放工作区的目录，例如 `/home/dsh/workspaces`。服务端和终端使用不同账号时，在向导中选择检测到的 DSH 系统服务。每个账号有自己的全局配置目录。要让终端和 DSH 服务读取同一份工作区文件，两边应使用相同的工作区绝对路径，并能读取其中的文件。

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
| Pi | settings、MCP、扩展、规则和 skills | Bash、Python 3.10+。通过 Kitto 安装 Pi CLI 需要 Node 22.19+ |
| Codex | 全局规则、skills、Kitto 插件，以及 Pi 源中启用 MCP 的白名单同步 | 登录 Codex，按需配置自己的模型和权限 |
| DSH | 全局规则、skills、指定 profile 的 Kitto bundle、白名单 MCP 同步，以及 CodeGraph 索引提醒/初始化（`desktop` 仅全局规则与 skills） | pnpm（web/headless）。通过 Kitto 安装 DSH CLI 需要 Node 24.9+；`--install-agents` 可补装 pnpm。Desktop 配置档由 App 管理，不需要 pnpm |

DSH 默认使用 `web`。已有其他 profile 时，首次 setup 加 `--dsh-profile <name>`，以后按该 profile 的原生方式启动。`desktop` 由 Desktop 应用管理，只支持全局规则与 skills，见上文「DSH Desktop 配置档」。

### 当前能力矩阵

| 能力 | Pi（macOS/Linux） | Codex | DSH（Linux；macOS 同一套规则） |
|---|---|---|---|
| 全局规则 | Kitto 覆盖整份 `~/.pi/agent/AGENTS.md` | Kitto 标记块 | Kitto 标记块 |
| 共享 skills | `~/.agents/skills` | `~/.agents/skills` + SessionStart hook | `~/.agents/skills`（`desktop` 无 scope provider） |
| 宿主专属 skills | Pi 上游包 | `config/codex/skills` 副本 | `config/dsh/skills` 副本 |
| 插件/扩展 | Pi 包、Pi 扩展 | Kitto Codex 插件 | Kitto DSH bundle（web/headless；`desktop` 无） |
| MCP | 共享 + 平台 + private + 项目级 | Kitto 同步白名单 server（无 env/headers） | Kitto 同步白名单 server（无 env/headers；`desktop` 不同步） |
| 模型/settings | Kitto 管理 | 宿主自管 | 宿主自管 |
| 凭据/env | `~/.pi-agent-env` | 宿主自管 | 宿主 env/service env |
| workspace scope | scoped-pi | scoped-codex | scoped-dsh（web/headless；`desktop` 无） |

`desktop` 是唯一的例外：它由 Desktop 应用独占，Kitto v1 只部署全局规则和 skills，不安装 bundle、不写 profile patch、不注册 scope adapter，也不同步 MCP home patch。

MCP：Pi 由 Kitto 管理共享、平台、private 和项目级条目。DSH 在 `setup` 和 `sync` 时由 Kitto 把 `config/pi/mcp.json`（叠加当前平台的 `config/pi/platform/<macos|linux>/mcp.json`，跳过 `enabled: false`）中没有 `env`/`headers` 的 server 同步为 `$DSH_HOME/cordis.patch.yml` 里的 `kitto-mcp-*` 条目；home patch 对所有 profile 生效，同步只增删这些条目，保留其它 YAML 行、注释和 `!!js`，Kitto 自己的条目按源顺序追加到末尾。`env`/`headers` server 会跳过并警告；`mcp.private.json` 和 `local/mcp.json` 根本不读取，仍需在 DSH 原生配置或环境中手动准备。

home patch、`profiles/*/cordis.patch.yml` 或已启用的 `mcp-manager` `servers` 已声明同名 server 时，跳过并警告。非空 flow 风格顶层 patch、`kitto-mcp-*` 与其它条目混在同一 `insert`、或生成结果无法解析（例如删除后留下未解析 alias）时会中止且不写入。设置 `KITTO_NO_MCP_SYNC=1` 可关闭同步；`maintain remove` 会删除 Kitto 自有条目。`desktop` 配置档不参与 MCP 同步（也不写 home patch）。Codex 的 MCP 由 Kitto 同步（见下），模型/settings 和凭据继续使用各自原生配置。

Codex 的启用 server 同样从该 Pi 源派生。同步只传递 stdio 的 command/args 或 HTTP 的 URL；env、headers、`env_http_headers` 和含 `${...}` 的凭据字段在 v1 不写入，相关 server 会跳过并给出原因。模型/settings 和凭据继续使用各自的原生配置。共享层只保证规则、skills 和 scope 语义一致。

Codex 的 MCP 归属记录在 `state.json` 的 `mcp.codex`：只有带有 Kitto 指纹且 live 配置未被改动的 server 才会被更新或删除。写入前，Kitto 先把目标指纹记为 pending；`codex mcp add` 成功并通过重新 list 校验后才转为正式归属。若进程在 live 写入后、state 保存前中断，下次 sync 会直接收养（`mcp adopt`），不会留下永久无归属的 server。verified list 确认 owned server 已从 live 消失时，Kitto 会清除旧指纹（`mcp forget`），避免之后误删同名同 transport 的用户 server。若中断的 add 只留下 pending、随后源条目被删除，pending 对应的 live server 会被移除；没有 live 或 transport 已被改动的 pending 会被清理（`mcp forget pending`）。同名但不是 Kitto 添加的 server、以及被本机修改过的 server（包括额外 env、headers、工具过滤或超时）都会保留，并在 `status`/`sync` 计划中标记为 `mcp conflict`。

Codex MCP 的已知边界：

1. 源文件必需：Kitto 从 `config/pi/mcp.json` 加当前平台覆盖生成计划；即使只选 Codex，缺少这个文件也会让 setup 明确失败。
2. 凭据和语义字段不映射：`env`、`headers`、`env_http_headers`、含 `${...}` 的字段，以及 Pi 源中的 `oauth`、`scopes`、`tools`/`toolFilter`、`timeout` 等字段不会写入 Codex。包含这些字段的 server 会整条跳过并打印原因，相关能力继续在 Codex 原生配置中维护。Pi 专用的 `lifecycle`、`directTools` 等展示/生命周期字段会被忽略。
3. `--url` 与 OAuth：Codex 0.170 的 `mcp add --url` 会先写 `config.toml`，再做认证发现；对需要 OAuth 的 URL，首次 add 可能等待约 30 秒后超时。Kitto 在写前已记录 pending；若超时/失败后 list 能看到 transport 完全一致且没有额外设置的 server，会立即 `mcp adopt` 并打印警告（提示 `codex mcp login <NAME>`），不会把 transport 不同的用户 server 误判为 Kitto 的；否则保留 pending，下次 sync 重试。认证本身仍需在 Codex 中完成。
4. Codex 原生字段不由 Kitto 写入：`startup_timeout_sec`、`tool_timeout_sec`、`enabled_tools`/`disabled_tools` 等如果出现在 live 中，会视为本机修改并保留，不会被覆盖。
5. TOML 重写：`codex mcp add/remove` 会重写配置，可能丢失注释（尤其是被操作的 `mcp_servers` 表及其邻近注释，更新已有 server 时文件顶部注释也可能消失）并调整 mcp 表顺序；Kitto 不直接写 TOML，只在 transport 有差异时调用原生命令。
6. `kitto remove` 预览与 `versions` 仍调用真实 Codex 读取插件/版本清单；Codex 可能在 `CODEX_HOME/tmp` 下创建 arg0 辅助文件，但不会修改 `config.toml`。`status`、`sync` 和 `setup --dry-run` 的 MCP 探测已使用临时 home。

`kitto status` 会用 `mcp pi/codex/dsh` 和 `mcp missing on …` 列出各宿主实际加载的 MCP 名称；它只读，不写任何宿主配置。`desktop` 配置档显示为 `mcp dsh: (global-only; MCP sync disabled)`，不参与缺失比较。读取 Codex MCP 时使用临时 `CODEX_HOME` 副本，不会在真实 Codex 目录下产生辅助文件。

### 一键迁移仍需要手动做的事

`setup` 会部署规则、skills、宿主注册和依赖检查，但以下项目按宿主/账号不同，必须手动完成：

1. 安装并登录各宿主 CLI（或用 `--install-agents` 只补装 CLI）。
2. Pi：复制 `config/pi/mcp.private.json` 并填写 host/token；把 `~/.pi-agent-env` 放进 shell 启动文件。
3. Codex：首次在 `/hooks` 信任 Kitto 的 SessionStart hook。
4. DSH：重启对应 profile/服务；Desktop 用户完全退出并重新打开 App（Kitto 只部署其全局规则/skills）；带 `env`/`headers` 的 MCP 和私有 MCP 仍需在 DSH 原生配置中手动添加。
5. 需要 CodeGraph 的仓库：在仓库根目录执行一次 `codegraph init`（Kitto 会提醒）。


## i-have-adhd 回复风格

使用本仓库的完整配置后，Pi、Codex 和 DSH 默认采用行动优先、分步呈现的回复风格。Pi 通过上游扩展启用常开模式；Codex 和 DSH 通过各自的全局工作约定加载同一版本的 skill。DSH 的 `i-have-adhd` 副本可由模型加载，AGENTS.md 会在会话开始要求加载它。向导的「仅配置共享规则与 skills」选项会跳过配置仓库里的这些内容。

在会话中输入 `normal mode` 或 `stop adhd mode` 即可恢复普通风格。需要重新启用时，Pi 输入 `/i-have-adhd`，Codex 和 DSH 可以说「使用 i-have-adhd」。维护时，Pi 包版本与两个宿主的 skill 副本应一起更新。 [上游固定版本](https://github.com/ayghri/i-have-adhd/tree/1ecea1993b7fce257ffbd686c070948b5e07eda6)

## 配置改在哪里

| 想改变什么 | 改哪里 |
|---|---|
| 多个 agent 共用的工作方法 | 仓库的 [skills/](../skills/) |
| 某一个 agent 的规则或专属 skill | [config/](../config/) 下对应宿主的 `AGENTS.md` 或 `skills/` |
| 某项能力用到的工具和版本 | [config/dependencies.json](../config/dependencies.json) |
| 只在本机生效的规则 | Codex 或 DSH 全局 `AGENTS.md` 的 Kitto 区块之外；Pi 使用 `config/pi/local/` |

默认配置来源是这个 GitHub 仓库。使用自己的 fork 时，首次 setup 加 `--source <Git-URL>`；要复用已有仓库，则传入本地路径。让 Kitto “检查配置状态”可以看到本机使用的源目录。共享 skills 默认由 Kitto 部署到 `~/.agents/skills/`。

`sync.sh` 只是 Kitto 内部的 Pi 适配器，不是公开入口。直接运行 `bash sync.sh` 会打印 deprecated 警告，并跳过共享 skills（`~/.agents/skills` 由 Kitto JS 按 hash 所有权和锁管理）；只有显式设置 `KITTO_ALLOW_LEGACY_SKILL_SYNC=1` 才按旧行为写入。需要同步时使用 `setup`，或在会话里让 Kitto 维护 skill 执行 sync。`setup.sh --force` 同样已废弃：它只打印一次警告并按普通 setup 运行。

## 换机与更新

在第一台机器上，告诉 Kitto 这次修改适用于哪些机器和 agent。检查配置仓库中的差异，提交并推送。到第二台机器，让 Kitto 从远端更新配置。遇到本地修改时，先处理报告里的冲突，再重试。

需要复现某次配置时，在 setup 命令末尾加 `--ref <已存在的-tag>`。Kitto 创建的配置仓库可以用同一参数切换到另一个 tag；自己提供的本地仓库用 Git 切换。状态中的 `deployed` 表示上次成功部署的提交，`checkout` 表示源目录当前的提交。检查上游工具版本时，可以直接说“用 Kitto 在线检查已启用工具的版本”。

## CodeGraph 索引与工作区权限

DSH 的 CodeGraph MCP 只查询已经建立索引的仓库。Kitto 在 `status` 中报告缺失的索引，并在 scoped `setup` 登记工作区后对其执行 `codegraph init`；这要求 `codegraph` 在 PATH 中。普通 `sync`、`deps`、`export` 不写索引。设置 `KITTO_NO_CODEGRAPH_INIT=1` 可以只提醒、不自动执行。

Kitto 也会检查已登记工作区是否对当前账号可写。只读工作区会让 agent 无法创建 `.codegraph`、`.pi` 或修改文件；setup 会打印警告。按提示给运行 DSH 的账号授予写权限（`chown` 或 `setfacl`）后重试。

## 安装失败或需要恢复

首次 setup 遇到配置冲突时，修正冲突后重跑原命令。加 `--dry-run` 可先看操作预览；对于尚未下载的远端配置，预览仅显示安装步骤。

如果升级后维护 skill 无法运行，在首页的安装命令末尾加 `--recover --dry-run` 查看恢复计划，再用 `--recover` 执行。恢复会切回之前验证过的 Kitto 程序并重新连接宿主。个人配置的历史版本通过 Git 恢复。

需要解除集成时，可以在 agent 里说“用 Kitto 预览解除集成”。解除 DSH 时会同时删除 `$DSH_HOME/cordis.patch.yml` 中 Kitto 自有的 `kitto-mcp-*` 行，保留其它内容；patch 无法安全解析时保留文件并警告，不阻塞解除。解除后仍保留个人配置、共享 skills 和宿主 CLI。

## 发布新版本

1. 在同一个 PR 里更新 `package.json`、`package-lock.json` 和 `integration/plugin.json` 的 `version`，并在 `CHANGELOG.md` 顶部新增对应小节，例如 `## 0.2.1`。发布脚本接受 `主版本.次版本.补丁版本` 格式的正式版本。
2. 等 PR 合入、CI 通过，在干净的工作树上切到最新的 `origin/main`。使用与 CI 一致的 Node.js 26，版本记录在 [`.node-version`](../.node-version)。还需要 npm、Git、Bash 和 Python 3.10+。正式发布时，当前账号需要能向 `origin` 推送 tag，并能向 npm 发布 `@phyzess/kitto`。
3. 在仓库根目录执行下面的命令。第一条从提交快照运行检查并生成临时 npm 包，第二条重复检查，随后推送 `v0.2.1` 并把同一份包发布到 npm `latest`。

   ```bash
   npm run release -- 0.2.1
   npm run release -- 0.2.1 --publish
   ```

如果 tag 已推送、npm 发布中断，回到同一个提交并用同一工具链重跑第二条。远端 tag 指向同一提交时可以继续发布。npm 上已有同版本时，脚本核对包的完整性摘要，吻合便视为已发布。

需要让某台机器复现这一版时，可以把程序和配置都固定到该版本：

```bash
npx --yes @phyzess/kitto@0.2.1 setup --ref v0.2.1
```
