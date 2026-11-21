# Roadmap：DSH Desktop 深度支持（暂缓）

[返回首页](../README.md) · [配置与同步指南](usage.md)

> 状态：**未实现，暂缓**。Kitto v1 对 DeepSeek Harness Desktop 保持 global-only：只部署全局 `AGENTS.md` 和 skills，不写 `profiles/desktop/cordis.patch.yml`，不注册 scope，也不同步 MCP。本文只记录后续 TODO、验收标准、风险和明确不做的事；不是承诺，不含日期，也不代表相关代码已经存在。用户明确要求前不要按本文改动实现。

## 背景

DeepSeek Harness Desktop 独占 `desktop` 配置档。npm 版 `dsh` CLI 会拒绝管理它，只有 Desktop 内置的 `dsh` 命令可以。Desktop 的应用更新还可能改变 profile 布局、patch 语义和全局规则/skills 的加载方式。Kitto v1 因此选择最小、可验证的边界：只碰全局文件和共享 skills，绝不写 App 独占的 profile。

这个边界让 Kitto 能安全地支持 Desktop 用户，但换不来 bundle、scoped 规则和 MCP 同步。B、C 两项是解除该限制前必须补齐的设计与验证。

## A. 当前基线：v1 global-only（已实现）

这是后续工作的安全基线，本 roadmap 不改变它：只部署全局 `AGENTS.md`、DSH 专属 skills 和共享 `~/.agents/skills`；不安装 bundle、不写 `profiles/desktop/cordis.patch.yml`、不注册 scope、不同步 MCP、不要求或安装 npm 版 dsh CLI，也不碰 Desktop 的 `package.json`、lockfile 或 profile 依赖。B、C 只有在不破坏这些边界并通过下文验收时才可能进入实现。

## B. 受控写入 `profiles/desktop/cordis.patch.yml` 的 Kitto scope/MCP 行

### 目标

允许 Kitto 在用户显式选择（默认关闭）时，只向 Desktop 的 profile patch 写入 **Kitto 自有的行**：

- `kitto-mcp-*` MCP home/profile 条目；
- Kitto scope/provider 所需的条目；
- 仅增删这些归属明确的行，保留用户行、注释、顺序和 `!!js` 等原生写法；
- 记录归属指纹，支持幂等重放、冲突保留和解除时的安全删除；
- 绝不改 Desktop App 的 `package.json`、lockfile 或 profile 依赖。

### 必须解决的竞态与护栏

- **App 完全退出**：写入前必须确认 Desktop 已完全退出（不是最小化），包括 profile 锁、运行中进程或 watcher 的状态检查；无法确认时拒绝写入，而不是“尽量试试”。
- **HMR/watch 竞态**：Desktop 可能在运行中监听 profile patch 并热加载。写入必须原子（临时文件 + rename 或等价方式），避免 watcher 读到半文件；写入期间或写入后 App 启动、热加载失败时的行为必须定义，且不能留下半套 Kitto 行。
- **恢复**：写入失败或 App 中途启动时，能回滚到写入前的 patch；解除集成时只删除 Kitto 自有行，用户内容和无法安全解析的文件保持原样。
- **并发**：与 `kitto setup`、`maintain remove`、scope 写入共用互斥，避免两个 Kitto 进程同时改同一文件。
- **凭据**：MCP 条目只允许 credential-free 白名单字段；`env`/`headers`/token 不写入，和现有 DSH web/profile 同步策略一致。

### 验证要求

- 在 Linux 上验证文件级行为、归属/回滚/并发和 dry-run；
- **macOS 实测**：必须在真实的 DeepSeek Harness Desktop 上验证 App 完全退出、启动、热加载和恢复流程，不能只靠文件模拟；
- 覆盖“App 已退出 / 运行中 / 写入时启动 / HMR 失败 / patch 被用户改动 / 解析失败”等路径；
- 验证现有 global-only 行为不受影响，未显式启用时零写入。

### 风险

- Desktop 的 profile 和 patch 语义没有稳定上游契约，App 更新可能直接破坏写入假设；
- 运行中写入可能被 HMR 半读取，导致 Desktop 配置损坏或会话异常；
- 与 App 自身条目、mcp-manager 或用户手写行重名时，错误删除用户配置的影响不可逆；
- macOS 与 Linux 的路径大小写、应用沙箱和 profile 位置可能不同，未实测等于未支持。

## C. Desktop 内置 CLI 检测/使用与 bundle/package/lockfile 边界

### 目标

- 检测 Desktop 提供的 `dsh` 命令（例如菜单里的 “Manage dsh Command…”）并区分它与 npm 版 CLI：版本、可用 profile 操作、是否真正管理 `desktop` profile；
- 只有在检测到内置 CLI 且能力匹配时，才把它用于只读探测或后续显式操作；检测不到就明确降级为 global-only，不用 npm 补装；
- 明确 Kitto bundle 在 Desktop 场景下的边界：能否安装、由谁管理依赖、App 更新时如何迁移、如何回滚。若没有可验证的所有权机制，就不提供 bundle 安装；
- 不修改 Desktop 应用的 `package.json`、lockfile 或 profile 依赖，也不绕过 App 的 CLI 直接改内部文件。

### 验收标准

- 检测结果区分 npm CLI、Desktop 内置 CLI、未初始化、不可用和超时，并给出可执行的下一步；
- 绝不因检测失败而用 npm 安装 dsh；`--install-agents` 对 desktop 保持不安装；
- 所有写操作都是显式 opt-in，先预览后应用；默认 setup 仍是 global-only；
- bundle/package/lockfile 的所有权、冲突和卸载路径有文档和测试；没有明确所有权时不实现；
- macOS 真实 App 实测通过；Linux 行为不回退。

### 风险

- 内置 CLI 是 App 内部接口，可能随时改名或移除；
- profile 依赖和 lockfile 由 App 所有，Kitto 的 bundle 写入可能被下一次 App 更新覆盖或迁移失败；
- “检测到 CLI”不等于“允许写 profile”，两者必须分开授权；
- 错误地把 npm CLI 当 Desktop CLI 使用，可能触发 App 的 profile 保护或损坏配置。

## 共同验收标准

1. 默认关闭、显式 opt-in，并保留 dry-run 预览；未启用时与 v1 完全一致。
2. 任何写入都可回滚；失败不改变 `state.json` 的已验证状态，也不留下半套 Kitto 行。
3. 只碰声明过的路径和 Kitto 自有内容；用户文件、App 文件和无法安全解析的 patch 保持原样。
4. Linux 自动化测试 + macOS 真实 Desktop 实测都通过后才可宣称支持。
5. 文档写明前置条件（完全退出 App、重启/重新打开）、恢复步骤和已知限制。

## 非目标

- 不自动更新 Desktop、不自动改 profile、不在 App 运行时写入；
- 不承诺在 Desktop 上获得与 web/headless 等价的 bundle、scope 或 MCP 能力；
- 不修改 Desktop App 自身的代码、安装包、`package.json`、lockfile 或依赖；
- 不用 npm 版 dsh CLI 管理 `desktop` profile，不用 `npx` 临时替代；
- 不因本 roadmap 改变 v1 的 global-only 行为或现有命令语义。

## v1 现状

当前（v1）Kitto 对 `desktop` 只部署全局 `AGENTS.md`、DSH 专属 skills 和共享 `~/.agents/skills`；不安装 bundle、不写 `profiles/desktop/cordis.patch.yml`、不注册 scope、不同步 MCP、不要求 pnpm 或 dsh CLI。需要 bundle、scoped 规则或 MCP 时请使用 `--dsh-profile web`（或 headless 等 Kitto 管理的 profile）。详见[配置与同步指南](usage.md#dsh-desktop-配置档v1仅全局规则与-skills)。
