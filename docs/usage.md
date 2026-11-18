# 配置与同步

[返回首页](../README.md)

## 选择 agent

首页的 setup 默认选择本机已安装的 agent。只想配置 Codex 时，在安装命令末尾加 `--agents codex`。如果新机还没有 Codex，加 `--agents codex --install-agents` 即可一起安装。多个宿主用逗号分隔，例如 `--agents pi,codex`。再次 setup 可以追加宿主。

| 宿主 | Kitto 管理的内容 | 使用前准备 |
|---|---|---|
| Pi | settings、MCP、扩展、规则和 skills | Bash、Python 3.10+。通过 Kitto 安装 Pi CLI 需要 Node 22.19+ |
| Codex | 全局规则、skills 和 Kitto 插件 | 登录 Codex，按需配置自己的模型、权限和 MCP |
| DSH | 全局规则、skills 和指定 profile 的 Kitto bundle | pnpm。通过 Kitto 安装 DSH CLI 需要 Node 24.9+；`--install-agents` 可补装 pnpm |

DSH 默认使用 `web`。已有其他 profile 时，首次 setup 加 `--dsh-profile <name>`，以后按该 profile 的原生方式启动。

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

## 安装失败或需要恢复

首次 setup 遇到配置冲突时，修正冲突后重跑原命令。加 `--dry-run` 可先看操作预览；对于尚未下载的远端配置，预览仅显示安装步骤。

如果升级后维护 skill 无法运行，在首页的安装命令末尾加 `--recover --dry-run` 查看恢复计划，再用 `--recover` 执行。恢复会切回之前验证过的 Kitto 程序并重新连接宿主。个人配置的历史版本通过 Git 恢复。

需要解除集成时，可以在 agent 里说“用 Kitto 预览解除集成”。解除后仍保留个人配置、共享 skills 和宿主 CLI。
