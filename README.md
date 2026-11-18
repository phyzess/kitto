# Kitto

在现有 pi-config 上统一个人配置迁移和维护，支持 macOS / Linux。日常直接启动 `pi`、`codex` 或 `dsh web`，在 agent 内让 Kitto 处理配置维护。

Kitto 通过 npm 分发，个人配置保存在 Git 仓库中。

## Kitto 安装入口

在新机器上运行：

```bash
npx --yes @phyzess/kitto setup
```

默认选择本机已安装的 agent，自动准备 `phyzess/kitto` 的默认分支。若已有配置 checkout，可以通过 `--source /path/to/pi-config` 继续使用；首次 clone 可用 `--ref` 选择分支或 tag。Kitto 创建的 checkout 可以用同一入口的 `--ref TAG` 切换快照，需要先提交或处理本地修改。`--dry-run` 只读预览，不创建目录或 clone。

新机器上指定 agent，并安装缺失的 CLI：

```bash
npx --yes @phyzess/kitto setup --agents pi,codex,dsh --install-agents
```

Kitto 需要 Node >=22 和 Git。Pi 同步还需要 Bash、Python >=3.10 和 `config/pi/`；DSH 原生插件管理需要 PATH 中有 pnpm。通过 Kitto 安装宿主时，Pi 和 DSH 分别需要 Node >=22.19 和 >=24.9。`--install-agents` 安装缺失的宿主 CLI，并为 DSH 补齐缺失的 pnpm（12.21.0）；不会升级已有工具。DSH 当前仍是预发布版本。登录和 API key 通过各自原生入口设置。

重复 setup 会复用配置来源和已选 agent；`--agents` 可追加宿主，不会隐式卸载旧宿主。

| 内容 | 管理方式 |
|---|---|
| Kitto 代码 | 保存到 `~/.local/share/kitto/runtime`，不依赖临时 npx 缓存 |
| 个人配置 | 自动 clone 到 `~/.local/share/kitto/config`，或使用已有 checkout |
| 自建 skills | 共享内容部署到 `~/.agents/skills`，`config/<agent>/skills/` 仅部署到对应宿主的原生目录 |
| Pi | 复用原有 settings / MCP / extensions / AGENTS 同步，注册 Kitto 原生包 |
| Codex | 同步 `config/codex/AGENTS.md` 到用户规则中的 Kitto 区块，并注册原生插件 |
| DSH | 同步 `config/dsh/AGENTS.md` 到用户规则中的 Kitto 区块，并向所选 profile 注册 bundle |

这是**用户全局 setup**，不在项目里创建配置，也不包办项目初始化。`KITTO_HOME` 或 `XDG_DATA_HOME` 可以改变 Kitto 存放位置。宿主的 `CODEX_HOME`、`DSH_HOME`、`PI_CODING_AGENT_DIR` 会被记录用于维护；启动宿主时仍使用自己的环境设置。选择 Codex 时，共享 skill 根目录必须是 `~/.agents`。

DSH 默认使用 `web`。首次选择其他 profile 时给 setup 加 `--dsh-profile <name>`。自定义 profile 要先用 DSH 初始化。Kitto 会记住所选 profile，用于版本盘点、恢复和卸载。规则和 DSH 专属 skills 的范围是整个 DSH 用户目录。

Codex / DSH 的规则可直接在配置仓库编辑。Kitto 保留本机规则区块外的文字，发现 Kitto 区块被改动时停止同步。`AGENTS.override.md` 仍按 Codex 的原生规则取得优先级。模型、登录、权限和 MCP 继续各自配置。跨宿主 skill 应在可选工具缺失时使用原生工具降级。

## 重建已发版的配置

```bash
npx --yes @phyzess/kitto@0.1.0 setup --ref v0.1.0
```

已发布的 npm 版本和同名 Git tag 对应同一次验证。tag 安装保持在固定提交。普通分支安装继续快进更新。`status` 中的 `deployed` 记录上次成功部署时的 Git 提交及工作区修改状态，`checkout` 显示当前源目录状态。宿主和系统依赖仍由各自的安装器提供。

## 日常使用

在 agent 内使用 Kitto skill，例如：“检查我的配置和版本”“从配置仓库同步最新配置”“导出这台机器的 Pi 配置”。只维护配置时才加载它，不给普通开发任务增加流程。

- 同步先预览。远端更新只允许干净 checkout 的 fast-forward；本机未提交改动、分叉历史、被修改的共享 skill 都会停止并说明冲突。
- 导出只写本地配置 checkout，不自动 commit 或 push；跨机器共享仍使用该仓库的 Git 远端。
- 依赖安装由对应能力触发，并可在会话中预览。例如启用 Pi 的调试 MCP 时才列出 `dap-mcp-server` 和 `debugpy`。共享 CodeGraph 只检查本机命令，并提示在会话中确认 MCP 工具是否可用。
- 版本检查默认离线，盘点已选宿主、技能、实际启用的 Pi MCP、Codex 插件和所选 DSH profile 的 bundle。在线检查单独显示 npm / PyPI 的上游信息。
- Pi 会异步检查 Kitto 自身的稳定版更新，最多每天一次、请求限时两秒、离线静默；`KITTO_UPDATE_CHECK=0` 可关闭。它不重复扫描 Pi 插件。Codex / DSH 当前通过 Kitto skill 主动检查更新。
- 普通配置同步不重复安装 Kitto 的原生集成。升级 Kitto 代码时重新执行目标版本的 setup，再按宿主原生方式重新加载资源。

安装失败后可修复原因重跑 setup。升级会保留最后一份已验证成功的代码备份，失败重试或同版本重装不会覆盖它。在 agent 内让 Kitto 预览并执行恢复即可；若安装的维护入口已损坏，可通过同一个安装入口救援：

```bash
npx --yes @phyzess/kitto setup --recover --dry-run
# 看过预览后，去掉 --dry-run 执行恢复
```

恢复仅切换 Kitto 代码并重新连接原生集成，保留当前个人配置、共享 skill 和 Git checkout。它不是全部文件和依赖安装的事务回滚。没有已验证备份时，使用已知可用的 Kitto 版本重新 setup。

解除集成也在 agent 内交给 Kitto：先预览，再执行。内部调用三个宿主的原生移除命令，仅解除 Kitto 包 / 插件 / bundle，并清理 Pi 本机包清单中缓存的 Kitto 路径。中途失败可重试；遇到同名集成已换成其他来源会停止。配置仓库、共享 skill、宿主 CLI、登录信息和 Kitto 救援文件都保留。解除后普通 sync 不会重新安装；需要时重新 setup 即可。

实现范围和验证记录见 [docs/kitto-progress.md](docs/kitto-progress.md)。

## 原有 Pi 脚本（兼容入口）

同步是**双向**的：`sync.sh pull` 把仓库打到本机，`sync.sh push` 把本机改动脱敏后写回仓库。

### 首次复刻

```bash
git clone git@github.com:phyzess/kitto.git
cd kitto
bash setup.sh --dry-run   # 先看会做什么
bash setup.sh             # = deps（按平台装依赖）+ pull（部署配置）
```

以下脚本继续保留，供调试和已有使用方式兼容；Kitto 在内部复用相同实现：

| 命令 | 行为 |
|---|---|
| `bash sync.sh status` | 只读：列出仓库与本机的差异、包状态、MCP 开关 |
| `bash sync.sh pull` | 仓库 → 本机。文件按内容比对，`settings.json` / `mcp.json` 走结构化合并 |
| `bash sync.sh push` | 本机 → 仓库。剥掉运行时键与机器专属包，`git status` 供审查 |
| `bash sync.sh push --commit` | 同上，并提交 `chore: sync pi config from <host>` |
| `bash sync.sh deps` | 按平台装 brew / mise / npm / pip 依赖 |

`settings.json` 保留未被仓库管理的设置，共享设置更新后再应用本机覆盖。
MCP 的共享定义按仓库、平台、本机 local 更新，已有运行开关保留；local 中明确设置的开关优先。
首次真实 pull 记录共享包归属，后续从仓库删除包会移除其加载声明，未知本机包继续保留。首次迁移前没有归属记录的包按本机额外包处理，避免误删。

`status` 与 `--dry-run` 不修改仓库或本机配置。已有 `~/.pi-agent-env` 保持原样；首次创建时权限为 600。写操作使用本机锁，若进程被强制终止留下锁目录，需确认无同步进程后清理 `config/pi/local/.sync-lock`。

## 仓库内容

```
config/pi/
  settings.json                  providers / packages / compaction / theme
  AGENTS.md                      全局规则（中文）
  mcp.json                       跨平台 MCP 服务器（6 个）
  mcp.private.example.json       私有 MCP 模板（gitlab / atlassian / figma）
  mcp.per-project.example.json   按仓库启用的 MCP 模板
  platform/macos/mcp.json        macOS 专属服务器（computer-use）
  platform/linux/mcp.json        Linux 覆盖层（缺二进制的先 enabled:false）
  extensions/                    本地 TypeScript 扩展（3 个）
  i-have-adhd-always             ADHD 输出模式常开标记
  local/                         【本机专属，gitignore】包清单 / MCP 覆盖 / settings 覆盖
config/env.example               环境变量模板 → 部署为 ~/.pi-agent-env
skills/                          自建 skills（5 个）
lib/pi_config.py                 settings / mcp 的结构化合并
sync.sh                          双向同步入口
setup.sh                         首次安装 = deps + pull
```

## 平台差异

| 项 | macOS | Linux |
|---|---|---|
| CLI 依赖 | Homebrew | mise npm 后端 |
| Python 依赖 | `pip3` | `python3 -m pip`，没有就 warning 跳过 |
| `computer-use` MCP | `platform/macos/mcp.json` 启用 | 不下发 |
| `herdr-agent-state.ts` | 部署 | 跳过（herdr 自己管理） |
| 私有 MCP token | 环境变量或 keychain `security` | 环境变量（`~/.pi-agent-env`） |

缺二进制的 MCP（codegraph / serena / dap-debug / chrome-devtools）在 Linux 上由
`platform/linux/mcp.json` 先关掉。装好依赖后删掉对应 `enabled: false`，再跑 `sync.sh pull`。

## 本机专属配置 `config/pi/local/`

整个目录被 gitignore，`pull` 初始化时会自动生成，`push` 永远不会带上它：

| 文件 | 作用 |
|---|---|
| `packages.txt` | 本机额外 pi 包（pull 合并进 settings，push 时不回流） |
| `managed-packages.json` | 上次真实 pull 的共享包归属记录，不随仓库同步 |
| `packages.skip.txt` | 本机不装的包。例：`npm:pi-ask-user` 与 `rpiv-ask-user-question` 工具名冲突 |
| `settings.json` | 覆盖仓库 settings 的键（深度合并，最后生效） |
| `mcp.json` | 本机额外 / 覆盖的 MCP 服务器 |

## pi 扩展包

| 包 | 用途 |
|---|---|
| pi-subagents | 子 agent 并行编排 |
| pi-web-access | 网页搜索 + 内容抓取 |
| pi-hashline-edit-pro | 按锚点的精确编辑 |
| pi-ask-user | 结构化单选/多选提问 |
| pi-intercom | 多个 pi 会话之间通信 |
| @plannotator/pi-extension | 浏览器里评审方案 / 代码 / PR |
| i-have-adhd（git 源） | ADHD 输出模式 |

包清单以 `config/pi/settings.json` 的 `packages` 为唯一来源。`sync.sh` 从那里读、逐条
`pi install`，已声明的跳过。包版本升级与首次安装分开处理；本机额外包保留配置，当前脚本不会自动为其补装。

`settings.json` 不记录 `lastChangelogVersion` 和 `extensionChangelogVersions`：这两个键每次
启动都变，写进仓库只会立刻产生 diff。`push` 会自动剥掉它们。

## MCP 服务器

### 跨平台（6 个）

| 服务器 | 说明 |
|---|---|
| context7 | 库文档查询 |
| codegraph | 代码知识图谱，`directTools` |
| serena | 语义代码检索，`directTools` |
| dap-debug | DAP 断点调试（lldb / debugpy / dlv） |
| ast-grep | 结构化搜索 / 改写 |
| chrome-devtools | CDP 级浏览器调试 |

除 context7 外都标了 `lifecycle: "lazy"`，按需启动。

### 平台 / 私有

`computer-use`（macOS 桌面控制）在 `platform/macos/mcp.json`。
`gitlab` / `atlassian` / `figma` 走 `mcp.private.json`（gitignore）：

```bash
cp config/pi/mcp.private.example.json config/pi/mcp.private.json
# 把 YOUR_*_HOST 换成真实地址，token 保持 ${VAR} 形式
bash sync.sh pull   # 自动合并进 ~/.pi/agent/mcp.json
```

token 用 `${VAR}` 占位，由环境变量注入 —— pi 会在 `env` 和 `headers` 的值里展开 `${NAME}`。
变量写在 `~/.pi-agent-env`（首次 `pull` 从 `config/env.example` 创建，后续保留本机内容），并在 `~/.zshrc` 里 `source`。

不想用环境变量，也可以让 macOS keychain 直接给值 —— `!` 命令必须占满整个值：

```json
"gitlab_read_token": "!security find-generic-password -a $USER -s agent-mcp-gitlab -w"
```

### 按仓库启用

把需要的服务器从 `config/pi/mcp.per-project.example.json` 拷到目标仓库的 **`.pi/mcp.json`**
（注意不是 `.mcp.json`）。pi 只在**项目被信任**之后才读这份文件；同名条目会覆盖用户级配置，
只写 `enabled` / `exposure` / `toolExposure` 的条目则只做覆盖、其余字段继承。

改完在项目里跑 `pi mcp list` 校验。

## Skills（5 个）

`codegraph`、`diagnose`、`hindsight`、`improve-codebase-architecture`、`tdd`

只放自建 skill，部署到 `~/.agents/skills/<name>`。包自带的 skill 不复制 ——
`@plannotator/pi-extension`、`pi-subagents`、`pi-intercom`、`pi-ask-user` 自带各自的 skill；
`ego-browser` 是软链到 `~/.local/share/ego/ego-skills`，由 ego 安装器管理，`push` 遇到软链会跳过。

## extensions（3 个）

| 文件 | 作用 |
|---|---|
| thin-cursor.ts | 去掉反色方块光标，露出终端硬件光标 |
| herdr-agent-state.ts | herdr pane 里显示 agent 运行状态（仅 macOS） |
| openrouter-live.ts | OpenRouter 实时模型列表 |

部署到 `~/.pi/agent/extensions/`。`thin-cursor.ts` 依赖 `settings.json` 里的 `showHardwareCursor: true`。

## 依赖清单

在 `config/dependencies.json` 中编辑工具依赖。每条规则用 `agent`、`skill`、`piCommand` 或 `piNpx` 选择能力，可用 `platform` 限制为 `darwin` 或 `linux`。用 `executable` 检查命令是否在 PATH 上，用 `install` 声明 `brew`、`mise` 或 `pip` 安装方式。mise 的 npm 包使用具体版本。旧配置仓库仍可使用 `lists/`。

不走清单、用自己的安装器装的三个：

```bash
npm i -g @earendil-works/pi-coding-agent   # pi 本体
curl -fsSL <codegraph install.sh> | sh     # codegraph  → ~/.codegraph/
uv tool install serena-agent               # serena     → ~/.local/share/uv/tools/
```

## 维护

日常直接改 `~/.pi/agent/`、`~/.agents/skills/`，然后：

```bash
bash sync.sh status        # 确认差异符合预期
bash sync.sh push          # 脱敏导出到仓库
bash sync.sh push --commit # 导出并提交
git push
```

`push` 会：剥掉 `lastChangelogVersion` / `extensionChangelogVersions`；把
`local/packages.txt` 与 `packages.skip.txt` 里的包留在本机；把 `platform/*/mcp.json` 和
`mcp.private.json` 里的服务器排除在外；跳过 herdr 托管的扩展和软链 skill。仅导出仓库已存在的 skills 与扩展，不自动收集第三方目录。本机 settings 覆盖不会回流；MCP 的 local/private 覆盖不删除仓库中原有的共享定义。

`push --commit` 会拒绝已有暂存改动，只暂存托管配置路径，避免提交无关文件。添加自建 skill 时，请先在仓库中明确建立该 skill 目录。

需要"从仓库删除某个包"时，直接编辑 `config/pi/settings.json` —— `push` 只会追加新包，
不会因为本机卸载就删掉仓库条目。

## 已知注意点

- `context-mode` 2.1.8 要求 Node ≥ 24.15.0；Node 24.14 会打印 `NODE_TOO_OLD`，不影响 pi 启动。
- `pi install` 会重写 `settings.json`，所以 `pull` 的顺序是「先装包、最后合并 settings」。

## 开发验证与版本盘点

维护开发时运行 `python3 -m unittest discover -s tests -v`。测试使用临时仓库和独立 HOME，Pi / mise 外部操作使用替身，不安装依赖或写入真实配置。CI 在 Linux 与 macOS 上运行同一组测试。

版本报告由 Kitto 维护 skill 调用。对 npx 启动的 MCP，报告以启动参数为声明来源。自建 skills 连同资源文件计算内容摘要。
