# Kitto

Kitto 把一套工作规则和 skills 带到 Pi、Codex 和 DeepSeek Harness（DSH）。每台机器设置一次。之后照常从项目目录启动 agent，或在 DSH Web 中选择项目。

## 换一台新机器

准备好 Node.js 26 和 Git，在终端运行：

```bash
npx --yes @phyzess/kitto@latest setup
```

用 ↑↓ 移动、空格勾选宿主、Enter 确认。随后从菜单选择配置来源，指定本地路径或 Git URL 时直接输入。选「使用默认 Kitto 配置」即可部署仓库里的规则、skills 和各宿主的 Kitto 集成。选择 Pi 时还会同步 Pi 包、扩展和 MCP 设置。已有自己的配置仓库时，可以填 Git URL 或本地路径。向导会询问是否补装缺少的 CLI 和辅助依赖，也可以在同一次运行里先预览，再确认安装。已有 Kitto 源码的机器可直接运行 `./setup.sh`。

## 以后才建工作区怎么办？

假设你会把项目放在 `~/workspaces/workspace-1/repo-a`。向导问「工作区父目录」时填 `~/workspaces`，即使这个目录还没建。以后在里面新建工作区、clone repo，开启新会话即可，无需再次 setup。

| 希望谁使用这条规则 | 写在哪里 |
| --- | --- |
| 当前账号下的所有项目 | `~/.local/share/kitto/global/AGENTS.md`，向导会打印实际路径 |
| `workspace-1` 下所有 repo | `~/workspaces/workspace-1/AGENTS.md` |
| 只有 repo-a | repo-a 自己的 `AGENTS.md`，可以随代码提交 |

全局和工作区的 skills 放在同层的 `.agents/skills/<名称>/SKILL.md`。没有额外约定时，工作区可以保持空白。父目录之外的项目也能使用账号的全局配置。

Codex 首次需要在 `/hooks` 中信任 Kitto 的 SessionStart hook。正在运行的 DSH 服务需要重启对应 profile。宿主登录和私有 MCP 凭据由各账号配置。

## 把改动带到下一台机器

把需要跨机器分发的内容改在配置仓库里，提交并推送。另一台机器的完整安装可以在 agent 会话里说「用 Kitto 检查并同步配置」。直接编辑全局或工作区文件会在对应目录生效，想跨机器复用时需将它们纳入自己的版本管理。

[配置与同步指南](https://github.com/phyzess/kitto/blob/main/docs/usage.md) · [Pi 配置参考](https://github.com/phyzess/kitto/blob/main/docs/pi.md) · [版本记录](CHANGELOG.md)
