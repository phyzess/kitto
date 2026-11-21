# Pi 配置参考

[返回首页](../README.md) · [配置与同步](usage.md)

## 按需求找文件

| 要做的事 | 配置来源 |
|---|---|
| 修改模型、主题、扩展包或固定版本 | [settings.json](../config/pi/settings.json) |
| 修改 Pi 的全局工作规则 | [AGENTS.md](../config/pi/AGENTS.md)（Pi addendum；共享部分见 [common.md](../config/instructions/common.md)） |
| 配置共享 MCP、平台差异 | [mcp.json](../config/pi/mcp.json)、[platform/](../config/pi/platform/) |
| 编辑仓库自带的 Pi 扩展 | [extensions/](../config/pi/extensions/) |
| 管理 MCP 所需命令和安装方式 | [dependencies.json](../config/dependencies.json) |

## 全局规则如何组合

Pi 的 `$PI_CODING_AGENT_DIR/AGENTS.md`（默认 `~/.pi/agent/AGENTS.md`）由 Kitto 在 pull 时生成：先是三个宿主共享的 [config/instructions/common.md](../config/instructions/common.md)，然后是一行固定的分隔哨兵 `<!-- kitto:host-addendum -->`，最后是 [config/pi/AGENTS.md](../config/pi/AGENTS.md)（Pi 专属 addendum）。因此：

- 改三个宿主都适用的规则，编辑 `common.md`；
- 改 Pi 的 MCP 工具表、浏览器或 Plannotator 约定，编辑 `config/pi/AGENTS.md`；
- 不要直接编辑本机生成的 `AGENTS.md`：pull 会按组合结果整份覆盖，旧版遗留的全文件也会被替换一次；
- `sync.sh push` 用分隔哨兵切分本机文件，只把 Pi 专属段写回 `config/pi/AGENTS.md`。缺少哨兵（旧组合）、共享段与当前 `common.md` 不完全一致（包括整段删除共享规则但本机尚未 pull），或组合结果不规范时，push 会在写仓库前拒绝并提示先同步，而不是把共享规则或已删除的规则写回 addendum。

需要本机或项目专属规则时，使用该工作区/仓库自己的 `AGENTS.md`。`config/pi/local/` 仍只覆盖 settings、MCP 和包清单。

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

`local/` 和 `mcp.private.json` 是机器专属文件：DSH/Codex 的 MCP 同步默认不读取它们，只有全局 `setup`/`update` 加 `--include-private` 才纳入。同步只接受 env/headers 里的完整 `${VAR}` 引用（HTTP `Authorization` 可用 `Bearer ${VAR}`）；字面值与字面 token 会整条跳过，原因只打印键名或 token 类型。URL userinfo、token/key/secret/password/sig/signature/auth 类 query，以及 command/args 中凭据形状的 flag（含 `--header`/`-H` 后跟敏感 header 名或凭据值）、env 赋值或字面 Authorization 也会被拒绝。`YOUR_*` 占位符尚未替换的条目也会跳过。

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

共享 skills 默认由 Kitto JS 管理（按 hash 记录所有权，并与 setup/sync 共用锁）。直接 `sync.sh` 绕过这层所有权会留下 hash 冲突，所以只有 `KITTO_ALLOW_LEGACY_SKILL_SYNC=1` 时才按旧逻辑复制 `~/.agents/skills`。settings、MCP、`AGENTS.md`、extensions 和 Pi 包等其他 Pi 功能仍然可用，便于兼容。直接运行时 `status` 也不会再把共享 skills 报成 missing/differs；只有显式 opt-in 后才按旧方式比较。`AGENTS.md` 的规则见上文「全局规则如何组合」：pull 组合 common + addendum，push 只导出 addendum；配置源没有 `common.md` 时沿用整文件旧行为，但本机文件含共享层哨兵时 push 会拒绝。

这里的 `push` 指把 Pi 配置导出到本地仓库。检查 Git 差异后，才执行 Git 的提交和推送。导出只写入仓库已经声明的 settings 键、MCP server、skills 和扩展；本机新增但未声明的项会在预览中点名并跳过，避免把临时 token 或实验配置带进仓库。凭据用 `${VAR}` 引用，写出字面 secret 时导出会拒绝。要在所有机器上移除扩展包，直接修改仓库的 `settings.json`。
