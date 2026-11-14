# pi-config

pi agent 环境的备份 + 在新机器上一键复刻，跨 macOS / Linux。

Kitto 改造在现有仓库内分阶段进行。目前已落地同步修复、版本盘点和回归测试；npm 安装入口与 Codex / DSH 适配尚未交付，当前仍使用下述 Pi 同步入口。

同步是**双向**的：`sync.sh pull` 把仓库打到本机，`sync.sh push` 把本机改动脱敏后写回仓库。

## 快速启动

```bash
git clone git@github.com:phyzess/pi-config.git
cd pi-config
bash setup.sh --dry-run   # 先看会做什么
bash setup.sh             # = deps（按平台装依赖）+ pull（部署配置）
```

日常只用 `sync.sh`：

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
lists/brew.txt                   Homebrew 依赖（macOS）
lists/mise-tools.txt             mise 全局 CLI 工具
lists/npm.txt                    跨平台 CLI（mise npm 后端，替代 brew 同名包）
lists/pip.txt                    Python 依赖
skills/                          自建 skills（5 个）
lib/pi_config.py                 settings / mcp 的结构化合并
sync.sh                          双向同步入口
setup.sh                         首次安装 = deps + pull
```

## 平台差异

| 项 | macOS | Linux |
|---|---|---|
| CLI 依赖 | `lists/brew.txt` | `lists/npm.txt`（mise npm 后端装 `@ast-grep/cli`） |
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

| 文件 | 内容 |
|---|---|
| `lists/brew.txt` | `ast-grep`（macOS，ast-grep-mcp 的前置） |
| `lists/npm.txt` | `@ast-grep/cli`（Linux，同上） |
| `lists/mise-tools.txt` | `dap-mcp-server`、`ast-grep-mcp`、`chrome-devtools-mcp` |
| `lists/pip.txt` | `debugpy`（Python 调试适配器） |

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

`lib/versions.py` 是供后续 Kitto 维护入口使用的只读内部程序，不增加日常操作要求。默认只盘点本机与仓库声明；显式传入 `--online` 时查询 npm / PyPI，保留 latest、next 等渠道，不自动选择或应用版本。程序检查安装清单与 npx 启动参数的差异，自建 skills 连同资源文件计算内容摘要。

无法确认实际版本或来源时报告空值及原因。npx 缓存、独立 uv 环境、Git 包安装目录等不从全局包版本推断；这些由后续宿主适配读取。版本查询结果不代表兼容性验证通过。
