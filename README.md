# Kitto

Kitto 把这份仓库里的个人配置带到每台开发机。换一台 Mac 或 Linux 机器后，Pi、Codex 和 DeepSeek Harness（DSH）都能用上你熟悉的工作规则和 skills。

## 新机安装

准备好 Git、Node.js 26 LTS（Kitto 最低要求 Node.js 22），以及你要使用的 agent。在任意目录运行一次：

```bash
npx --yes github:phyzess/kitto setup
```

这条命令从 GitHub 取得 Kitto，自动识别本机已安装的 agent，把配置部署到当前用户目录。Pi 还需要 Bash 和 Python 3.10+，DSH 需要 pnpm。如果机器上还没有 agent，见[安装选项](docs/usage.md#选择-agent)。

## 平时怎么用

照常启动 `pi`、`codex` 或 `dsh web`。需要维护配置时，在会话里直接说：

- “用 Kitto 看看，这台机器的配置和仓库有什么不同？”
- “用 Kitto 把仓库里的最新配置同步到这台机器。”
- “以后所有机器上的 Codex 都用中文回复，把这条写进配置仓库。”

想把改动带到另一台机器，先把配置提交并推送到 Git，再在另一台机器上同步。只属于本机的设置可以留在本地。

[配置与同步指南](docs/usage.md) · [Pi 配置参考](docs/pi.md) · [版本记录](CHANGELOG.md) · [发布新版本](docs/usage.md#发布新版本)
