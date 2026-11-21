# Kitto

Kitto 把一套工作规则和 skills 带到 Pi、Codex 和 DeepSeek Harness（DSH）。每台机器设置一次。之后照常从项目目录启动 agent，或在 DSH Web 中选择项目。

## 换一台新机器

准备好 Node.js 26 和 Git，在终端运行：

```bash
npx --yes @phyzess/kitto@latest setup
```

用 ↑↓ 移动、空格勾选宿主、Enter 确认。随后从菜单选择配置来源，指定本地路径或 Git URL 时直接输入。选「使用默认 Kitto 配置」即可部署仓库里的规则、skills 和各宿主的 Kitto 集成。选择 Pi 时还会同步 Pi 包、扩展和 MCP 设置。已有自己的配置仓库时，可以填 Git URL 或本地路径。向导会询问是否补装缺少的 CLI 和辅助依赖，也可以在同一次运行里先预览，再确认安装。

这是新机器唯一的安装入口。已经有 Kitto 源码时，在源码根目录运行 `./setup.sh --source .`；如果这台机器已经完成过 setup，直接 `./setup.sh` 会复用 state 里记录的配置源（没有 state 时会 clone 默认的 GitHub 仓库）。两种方式最终都执行 `kitto setup`。不要再直接运行 `sync.sh`：它只是 Kitto 内部的 Pi 适配器，见 [Pi 配置参考](docs/pi.md#syncsh内部适配器兼容用)。

## 以后才建工作区怎么办？

假设你会把项目放在 `~/workspaces/workspace-1/repo-a`。向导问「工作区父目录」时填 `~/workspaces`，即使这个目录还没建。以后在里面新建工作区、clone repo，开启新会话即可，无需再次 setup。

| 希望谁使用这条规则 | 写在哪里 |
| --- | --- |
| 当前账号下的所有项目 | `~/.local/share/kitto/global/AGENTS.md`，向导会打印实际路径 |
| `workspace-1` 下所有 repo | `~/workspaces/workspace-1/AGENTS.md` |
| 只有 repo-a | repo-a 自己的 `AGENTS.md`，可以随代码提交 |

全局和工作区的 skills 放在同层的 `.agents/skills/<名称>/SKILL.md`。没有额外约定时，工作区可以保持空白。父目录之外的项目也能使用账号的全局配置。

Codex 首次需要在 `/hooks` 中信任 Kitto 的 SessionStart hook。正在运行的 DSH 非 Desktop profile/服务需要重启对应 profile。宿主登录和私有 MCP 凭据由各账号配置。

### DSH Desktop

DSH Desktop 独占 `desktop` 配置档。Kitto v1 可以为它部署全局 `AGENTS.md`、DSH 专属 skills 和共享 `~/.agents/skills`，但不会安装 Kitto bundle、写 `profiles/desktop/cordis.patch.yml` 或注册 workspace scope。Kitto 不要求本机 `dsh` CLI，也不会用 npm 补装它，也不需要 pnpm。启动一次 Desktop 初始化 profile，然后完全退出 App，运行：

```bash
npx --yes @phyzess/kitto setup --agents dsh --dsh-profile desktop
```

重新打开 Desktop 后生效。需要 Kitto bundle、scoped 规则或 MCP 同步时，改用 `--dsh-profile web`；Desktop 内置 CLI 不能为 Kitto 提供这些能力。切换 profile 前先运行维护 skill 的 `maintain remove --apply` 解除当前集成。细节见[使用指南](https://github.com/phyzess/kitto/blob/main/docs/usage.md#dsh-desktop-配置档v1仅全局规则与-skills)。Desktop 的深度支持（受控写 profile patch、内置 CLI、bundle 边界）仍暂缓，只记录在 [DSH Desktop roadmap](https://github.com/phyzess/kitto/blob/main/docs/roadmap.md) 中。

## 把改动带到下一台机器

把需要跨机器分发的内容改在配置仓库里，提交并推送。另一台机器运行：

```bash
npx --yes @phyzess/kitto@latest update          # 预览，不写入
npx --yes @phyzess/kitto@latest update --apply  # 拉取配置、刷新 runtime、部署
```

`update` 先按 checkout 记录的分支/tag 更新配置源，再刷新 Kitto 自己的 runtime 副本，最后重新部署规则、skills 与 MCP（原生插件注册仍指向 runtime 路径，无需重装）。它不会升级 Pi、Codex、DSH 宿主 CLI（用各自的包管理器升级）；升级后重启宿主以加载新的插件代码。checkout 丢失时按记录的 `sourceUrl`/`sourceRef` 恢复；tag 固定、ref 未知或远端分支已删除时不会猜测，会提示原地重建 checkout 后重跑 setup，或换一个 `KITTO_HOME`。在 agent 会话里也可以说「用 Kitto 检查并同步配置」。直接编辑全局或工作区文件会在对应目录生效，想跨机器复用时需将它们纳入自己的版本管理。

宿主 CLI 的升级同样是显式操作，并且只升到 Kitto 已验证的基线，不追最新版，也不会自动发生：

```bash
npx --yes @phyzess/kitto@latest hosts          # 只读：当前版本、Kitto 基线、升级命令
npx --yes @phyzess/kitto@latest hosts --apply  # 只把低于基线的已选宿主升到基线
```

`--host NAME` 限定一个宿主，`--version X.Y.Z` 明确固定精确版本（不是已验证基线时会提示）。未选宿主不动，`desktop` DSH 由 Desktop App 管理。细节见[使用指南](https://github.com/phyzess/kitto/blob/main/docs/usage.md#宿主-cli只升到已验证基线不自动更新)。

[配置与同步指南](https://github.com/phyzess/kitto/blob/main/docs/usage.md) · [Pi 配置参考](https://github.com/phyzess/kitto/blob/main/docs/pi.md) · [DSH Desktop roadmap](https://github.com/phyzess/kitto/blob/main/docs/roadmap.md) · [版本记录](CHANGELOG.md)
