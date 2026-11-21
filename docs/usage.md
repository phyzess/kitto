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

打开新会话并说「使用 review 审查这个修改」。Pi 和 DSH 使用原生 skill 发现。Codex 通过 SessionStart hook 把工作区 skill 的说明和路径交给模型，原生 `/skills` 菜单仅列出 Codex 自己发现的条目。首次在 Codex 用 `/hooks` 信任 Kitto 的 hook；DSH 在重启对应 profile 后加载适配器。

`setup --global` 的文件位于 Kitto 数据目录的 `global/AGENTS.md` 和 `global/.agents/skills/`。默认数据目录为 `~/.local/share/kitto`。全局与工作区可以叠加，已登记的多层工作区按从外到内的顺序加载规则。同名 skill 的选择沿用各宿主的发现机制，给不同流程使用不同名称即可跨宿主一致引用。个人宿主扩展、模型和项目本身的设置继续使用各自的配置。

### DSH 使用独立服务账号

如果 Pi、Codex 在当前账号下运行，DSH Web 则由另一账号的 Linux systemd 系统服务启动，可以在有权限的 root 终端指定服务一次：

```bash
npx --yes @phyzess/kitto setup --workspace /home/dsh/workspace --dsh-service dsh.service
```

这会把同一工作区登记到两个账号。服务账号需要能访问工作区，命令从正在运行的服务取得宿主环境。正式应用后，在合适的时候重启该服务，再在 Web 中选 repo。每个项目继续使用同一套工作区文件。

## 选择 agent

交互向导默认选中检测到的宿主。下面的显式参数用于非交互部署配置仓库。只想配置 Codex 时，在安装命令末尾加 `--agents codex`。如果新机还没有 Codex，加 `--agents codex --install-agents` 即可一起安装。多个宿主用逗号分隔，例如 `--agents pi,codex`。再次 setup 可以追加宿主。

| 宿主 | Kitto 管理的内容 | 使用前准备 |
|---|---|---|
| Pi | settings、MCP、扩展、规则和 skills | Bash、Python 3.10+。通过 Kitto 安装 Pi CLI 需要 Node 22.19+ |
| Codex | 全局规则、skills 和 Kitto 插件 | 登录 Codex，按需配置自己的模型、权限和 MCP |
| DSH | 全局规则、skills、指定 profile 的 Kitto bundle，以及 CodeGraph 索引提醒/初始化 | pnpm。通过 Kitto 安装 DSH CLI 需要 Node 24.9+；`--install-agents` 可补装 pnpm |

DSH 默认使用 `web`。已有其他 profile 时，首次 setup 加 `--dsh-profile <name>`，以后按该 profile 的原生方式启动。

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

默认配置来源是这个 GitHub 仓库。使用自己的 fork 时，首次 setup 加 `--source <Git-URL>`；要复用已有仓库，则传入本地路径。让 Kitto “检查配置状态”可以看到本机使用的源目录。共享 skills 默认部署到 `~/.agents/skills/`。

## 换机与更新

在第一台机器上，告诉 Kitto 这次修改适用于哪些机器和 agent。检查配置仓库中的差异，提交并推送。到第二台机器，让 Kitto 从远端更新配置。遇到本地修改时，先处理报告里的冲突，再重试。

需要复现某次配置时，在 setup 命令末尾加 `--ref <已存在的-tag>`。Kitto 创建的配置仓库可以用同一参数切换到另一个 tag；自己提供的本地仓库用 Git 切换。状态中的 `deployed` 表示上次成功部署的提交，`checkout` 表示源目录当前的提交。检查上游工具版本时，可以直接说“用 Kitto 在线检查已启用工具的版本”。

## CodeGraph 索引与工作区权限

DSH 的 CodeGraph MCP 只查询已经建立索引的仓库。Kitto 在 `status` 中报告缺失的索引，并在 scoped `setup` 登记工作区后对其执行 `codegraph init`；这要求 `codegraph` 在 PATH 中。普通 `sync`、`deps`、`export` 不写索引。设置 `KITTO_NO_CODEGRAPH_INIT=1` 可以只提醒、不自动执行。

Kitto 也会检查已登记工作区是否对当前账号可写。只读工作区会让 agent 无法创建 `.codegraph`、`.pi` 或修改文件；setup 会打印警告。按提示给运行 DSH 的账号授予写权限（`chown` 或 `setfacl`）后重试。

## 安装失败或需要恢复

首次 setup 遇到配置冲突时，修正冲突后重跑原命令。加 `--dry-run` 可先看操作预览；对于尚未下载的远端配置，预览仅显示安装步骤。

如果升级后维护 skill 无法运行，在首页的安装命令末尾加 `--recover --dry-run` 查看恢复计划，再用 `--recover` 执行。恢复会切回之前验证过的 Kitto 程序并重新连接宿主。个人配置的历史版本通过 Git 恢复。

需要解除集成时，可以在 agent 里说“用 Kitto 预览解除集成”。解除后仍保留个人配置、共享 skills 和宿主 CLI。

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
