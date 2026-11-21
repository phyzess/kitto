# Pi 配置参考

[返回首页](../README.md) · [配置与同步](usage.md)

## 按需求找文件

| 要做的事 | 配置来源 |
|---|---|
| 修改模型、主题、扩展包或固定版本 | [settings.json](../config/pi/settings.json) |
| 修改 Pi 的全局工作规则 | [AGENTS.md](../config/pi/AGENTS.md) |
| 配置共享 MCP、平台差异 | [mcp.json](../config/pi/mcp.json)、[platform/](../config/pi/platform/) |
| 编辑仓库自带的 Pi 扩展 | [extensions/](../config/pi/extensions/) |
| 管理 MCP 所需命令和安装方式 | [dependencies.json](../config/dependencies.json) |

## 只改这台机器

在配置源的 `config/pi/local/` 中保存覆盖项。这个目录由 Git 忽略。

| 文件 | 用途 |
|---|---|
| `settings.json` | 覆盖本机设置 |
| `mcp.json` | 添加或覆盖本机服务器；可针对本机显式设置 `enabled` |
| `packages.txt` | 保留本机额外的包声明 |
| `packages.skip.txt` | 每行写一个要跳过的包，例如 `npm:pi-ask-user` |

例如，Linux 平台默认关闭 CodeGraph。在已装好 CodeGraph 的机器上，可以把下面的条目合并进 `config/pi/local/mcp.json`，再让 Kitto 同步：

```json
{ "mcpServers": { "codegraph": { "enabled": true } } }
```

私有服务器使用 [mcp.private.example.json](../config/pi/mcp.private.example.json) 作为模板，保存为同目录的 `mcp.private.json`。令牌通过环境变量提供。同步会根据当前配置的 Bash 或 Zsh 查找启动文件，必要时提示你加载 `~/.pi-agent-env`。

只对某个项目启用的服务器，可参考 [项目 MCP 模板](../config/pi/mcp.per-project.example.json)，把需要的条目写到项目的 `.pi/mcp.json`。

## sync.sh（内部适配器，兼容用）

`sync.sh` 是 `lib/kitto.mjs` 中 `syncCommand` 调用的 **Pi 私有适配器**，不是公开入口。正常安装和同步请使用 `kitto setup`，或在 Kitto 会话里让维护 skill 执行 sync。直接运行 `bash sync.sh` 会打印 deprecated 警告，并在没有显式 opt-in 时跳过共享 skills：

```bash
# 不推荐；仅为兼容旧脚本保留
bash sync.sh status
bash sync.sh pull --dry-run
bash sync.sh push --dry-run
bash sync.sh deps --dry-run

# 只有确实需要旧行为时才部署 ~/.agents/skills
KITTO_ALLOW_LEGACY_SKILL_SYNC=1 bash sync.sh pull
```

共享 skills 默认由 Kitto JS 管理（按 hash 记录所有权，并与 setup/sync 共用锁）。直接 `sync.sh` 绕过这层所有权会留下 hash 冲突，所以只有 `KITTO_ALLOW_LEGACY_SKILL_SYNC=1` 时才按旧逻辑复制 `~/.agents/skills`。settings、MCP、`AGENTS.md`、extensions 和 Pi 包等其他 Pi 功能仍然可用，便于兼容。直接运行时 `status` 也不会再把共享 skills 报成 missing/differs；只有显式 opt-in 后才按旧方式比较。

这里的 `push` 指把 Pi 配置导出到本地仓库。检查 Git 差异后，才执行 Git 的提交和推送。导出只写入仓库已经声明的 settings 键、MCP server、skills 和扩展；本机新增但未声明的项会在预览中点名并跳过，避免把临时 token 或实验配置带进仓库。凭据用 `${VAR}` 引用，写出字面 secret 时导出会拒绝。要在所有机器上移除扩展包，直接修改仓库的 `settings.json`。
