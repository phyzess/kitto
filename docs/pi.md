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

## 使用原有同步脚本

在配置仓库根目录运行。已有 Kitto 安装的用户也可以直接在 Pi 会话里请求相同操作。

| 命令 | 用途 |
|---|---|
| `bash sync.sh status` | 查看仓库与本机的差异 |
| `bash sync.sh pull --dry-run` | 预览仓库 → 本机，去掉 `--dry-run` 后部署 |
| `bash sync.sh push --dry-run` | 预览本机 → 仓库，去掉 `--dry-run` 后写入本地 checkout |
| `bash sync.sh deps --dry-run` | 查看已启用能力需要安装的工具 |

这里的 `push` 指把 Pi 配置导出到本地仓库。检查 Git 差异后，才执行 Git 的提交和推送。导出会过滤私有 MCP、本机覆盖和运行时字段；skills 与扩展只导出仓库已声明的目录或文件。要在所有机器上移除扩展包，直接修改仓库的 `settings.json`。
