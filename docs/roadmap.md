# Roadmap：剩余支持边界

[返回首页](../README.md) · [配置与同步指南](usage.md)

> 状态：**A 已实现；B–C（DSH Desktop 深支持）未实现、暂缓；D（其他剩余边界）部分已实现，部分是 TODO**。A 的 v1 global-only 基线、B/C 的 Desktop 设计不变；D 按主题记录现状、下一步、验收和风险。本文只记录后续工作，不是承诺，不含日期，也不承诺版本号；未标注“已实现”的行为不代表代码已经存在。用户明确要求前不要按本文改动实现。

## 背景

DeepSeek Harness Desktop 独占 `desktop` 配置档。npm 版 `dsh` CLI 会拒绝管理它，只有 Desktop 内置的 `dsh` 命令可以。Desktop 的应用更新还可能改变 profile 布局、patch 语义和全局规则/skills 的加载方式。Kitto v1 因此选择最小、可验证的边界：只碰全局文件和共享 skills，绝不写 App 独占的 profile。

这个边界让 Kitto 能安全地支持 Desktop 用户，但换不来 bundle、scoped 规则和 MCP 同步。B、C 两项是解除该限制前必须补齐的设计与验证。

Desktop 之外还有一组未闭环的边界：凭据表达、私有 MCP、宿主升级策略、插件/包 parity、Pi 规则所有权、DSH MCP 写入、低优先可用性限制，见 D。它们与 Desktop 的 B/C 不互相替代，也不改变 A 的 v1 基线。

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
- **凭据**：MCP 条目只允许白名单字段；凭据只能使用 `${credential:VAR}` 等宿主模板引用（需要时设置 `expandTemplates`），不写入任何明文凭据；`env`/`headers` 的值也必须是引用，不能是字面值。Desktop profile patch 对模板和 `expandTemplates` 的支持若比 home patch 更严格，需单独验证并在实现文档中说明，不能假定两者一致。

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

## D. 其他剩余边界（按主题拆分）

本节记录与 Desktop 深度支持无关、但尚未闭环的边界：多数能力已有可工作的部分实现或明确的拒绝路径，剩余的是安全表达、跨宿主语义统一、策略定义和低优先可用性改进。每条自带状态和验收；下文「共同验收标准」仍只约束 A–C 的 Desktop 工作，不自动适用于本节。D 的各项互相独立，可以单独推进；未标注“已实现”的下一步都只是候选方向，不是承诺。

### D.1 Codex 凭据/传输边界

**状态**：部分实现。安全跳过已有实现；让被跳过的字段安全表达仍未实现。

**当前行为**：Codex MCP 同步只传递 stdio 的 `command`/`args` 或 HTTP 的 `url`。唯一会写进 Codex 的凭据是单个 `Authorization: Bearer ${VAR}`，映射为 `codex mcp add --url … --bearer-token-env-var VAR`；归属指纹只记录变量名。stdio 的 `env`/`env_vars`、其他 HTTP headers、`env_http_headers`、`bearer_token_env_var`、`oauth`、`scopes`、`tools`/`toolFilter`/`enabled*_tools`、超时字段和 `cwd` 等无法由 `codex mcp add` 安全表达，包含这些字段的 server 会整条 skip，并打印键名或原因。字面 secret、模板出现在 `url`/`command`/`args`、URL userinfo/凭据类 query、command/args 里的凭据形态同样拒绝。Kitto 不直接写入 `config.toml`，只调用 Codex 原生命令。

**下一步 / 验收**：下一步是实测 Codex 原生或受管配置能否在不写明文的前提下表达上述字段（例如 env 引用、额外 headers、OAuth、工具过滤），验证通过才纳入；无法验证的字段继续整条 skip，并给出到宿主原生配置补全的提示。验收：在真实 Codex 上覆盖 stdio env、多 headers、OAuth、scopes/tool filters；落盘文件、argv、日志都不得出现明文 secret；plan/apply/status 的 skip 原因一致；失败信息不回显 argv；现有 bearer 映射与所有权/收养逻辑不回退。

**风险 / 非目标**：Codex 原生命令语义和 `config.toml` 布局会随宿主变化，直接重写 TOML 可能丢注释并引入明文；不承诺 Pi 字段全量直通，不做凭据代理或 secret 存储，也不替用户完成 OAuth 登录。

### D.2 私有/本机 MCP 同步

**状态**：部分实现。opt-in 与引用式同步已实现；跨宿主引用语义和失败诊断未统一。

**当前行为**：`config/pi/mcp.private.json`（Git 忽略）和 `config/pi/local/mcp.json` 对 DSH/Codex 同步默认不读取（Pi 自身的 MCP 合并仍会读取它们）；只有全局 `setup`/`update` 加 `--include-private` 才纳入，选择记录在 `state.json`，`--no-include-private` 关闭，scoped setup 拒绝这两个参数。叠加顺序为 base < platform < local < private，两个文件都可选。同步只接受完整 `${VAR}`（`Authorization` 可为 `Bearer ${VAR}`）；字面值、局部模板、URL userinfo/凭据类 query、command/args 凭据形态和残留 `YOUR_*` 占位符整条 skip。DSH 映射为 `${credential:VAR}` 模板并在该行启用 `expandTemplates`；Codex 只映射 bearer 环境变量名；Pi 继续使用 shell 环境或 `~/.pi-agent-env`。三个宿主的凭据 provider 和生效时机不同，缺变量时没有统一诊断。

**下一步 / 验收**：下一步统一引用语义（变量名规则、`Bearer ${VAR}` 的适用范围）和失败诊断（缺变量时能定位到宿主、server 和键名，且绝不输出值），并评估三宿主 provider 差异的提示方式。验收：同一份 private 配置在 Pi/Codex/DSH 的 dry-run/apply 行为可预测；缺失变量、占位符、字面值、错误 header 的报错只含路径/键名/类型；默认不读 private/local；任何路径都不新增明文写入；`--include-private` 的持久化和关闭路径不回归。

**风险 / 非目标**：不把 Pi 的 env 启动文件扩成通用 secret 管理器；不承诺三个宿主的凭据来源等价；不写 secret 存储、不生成明文 env、不自动修改用户的 shell 启动文件。

### D.3 宿主 CLI 更新策略

**状态**：部分实现。只升已验证基线、显式降级、预览和安装后校验都已实现；已验证旧基线清单和基线提升策略未定义。

**当前行为**：`kitto hosts [--check|--apply] [--host NAME] [--version V]` 只处理已选宿主。默认目标是代码中的 Kitto 基线 `hosts[name].version`，不追 npm `latest`、不用 `npx`、不自动升级；`--version` 只接受精确版本，属于显式覆盖并警告“未经 Kitto 验证”。当前版本高于基线时不会隐式降级；同时指定低于当前版本的 `--version`（多选宿主时还需 `--host`）时，`--apply` 执行显式降级，`--check` 只预览并给出同一警告，安装后按精确版本校验，失败不写 `state.json`。`desktop` 的 DSH 由 App 管理，Kitto 不安装或固定其 CLI；`kitto update` 只打印宿主版本，不升级。基线本身随 Kitto 发布改变，但“什么时候允许提升基线、哪些旧版本算已验证的回退目标”没有成文策略。

**下一步 / 验收**：下一步定义基线提升条件（真实宿主回归、旧基线兼容窗口、需要同步更新的验证矩阵）和“已验证旧基线”清单，让回退目标有依据；不重新设计显式降级机制，也不引入后台自动检查。验收：每次基线变更都有可复现的验证记录；显式降级保留现有语义（opt-in、先预览、警告未验证、安装后精确校验、失败不写 `state.json`）并补回归测试；`desktop` 始终跳过；显式 `--version` 仍标注未经基线验证。

**风险 / 非目标**：宿主原生升级可能破坏兼容；自动追最新版会绕过验证；不提供常驻更新服务，不自动降级（降级必须由用户显式 `--version` 触发），也不把 `hosts --apply` 变成通用包管理器。

### D.4 宿主插件/包 parity

**状态**：未实现（仅原生清单）。跨宿主的插件/包/扩展 capability parity 没有实现，也没有统一清单。

**当前行为**：三个宿主的扩展机制是原生的：Pi 用 packages 和 extensions，Codex 用插件（含 Kitto Codex 插件），DSH 用 bundle（web/headless 的 Kitto bundle；`desktop` 无）。Kitto 共享规则、skills、scope 语义，并按白名单同步 MCP，但不维护统一插件清单，也没有跨宿主的插件/包能力对比。现有只读输出只是各宿主原生清单和 MCP 名称对比：`versions` 列出 Pi 包/扩展、Codex 插件、DSH bundle；`status` 对 Pi 对比 settings/MCP/AGENTS/extensions/packages 等原生项，并跨宿主打印 `mcp <host>` / `mcp missing on <host>`。这些都不是插件/包级别的 parity 报告。

**下一步 / 验收**：下一步只评估是否值得做只读 capability 报告（例如按宿主列出已安装插件/包、是否 Kitto 管理、可用/缺失提示），不引入通用插件框架。若实现，验收：报告只读、默认不写宿主、区分 Kitto 自有与用户自有、不定义统一安装语义、失败只提示不阻塞，且不改变 `setup`/`sync` 行为。

**风险 / 非目标**：三宿主插件模型不等价，统一抽象会过度承诺；不做跨宿主插件安装器、依赖解析器或版本对齐器，也不因 parity 报告自动安装任何东西。

### D.5 Pi 全局规则所有权

**状态**：部分实现（有意的整份管理）。本地段保留/多来源合并未实现。

**当前行为**：Pi 的 `$PI_CODING_AGENT_DIR/AGENTS.md`（默认 `~/.pi/agent/AGENTS.md`）由 Kitto 把 `common.md`、分隔哨兵 `<!-- kitto:host-addendum -->` 和 Pi addendum 组合后整份写入；pull 按组合结果整份覆盖。本机或项目专属规则应写在 workspace/repo 自己的 `AGENTS.md`，不要直接改 Pi 全局文件。Codex/DSH 只替换 Kitto 标记块、保留块外内容，Pi 没有等价的块外机制。

**下一步 / 验收**：下一步明确是否要给 Pi 引入可保留本地段的边界（例如 Kitto 管理块或显式合并规则），并定义从整文件迁移时不覆盖用户内容的做法。验收：若引入合并，先 dry-run 展示将保留/将覆盖的段；本地段不被改写；`sync.sh push` 仍只导出 Pi addendum；冲突时拒绝而非覆盖。

**风险 / 非目标**：Pi 侧没有现成的块级边界，随意合并可能让已删除的共享规则“复活”或重复；不改变 Pi 的其他设置，不把全局规则文件扩成多来源规则引擎，也不在用户未确认时改写其本地内容。

### D.6 DSH MCP 写入边界

**状态**：部分实现。引用式 env/headers 已支持；其余写入形态明确 skip/拒绝，扩展支持未实现。

**当前行为**：`setup`/`sync` 只增删 `$DSH_HOME/cordis.patch.yml` 中以 `kitto-mcp-*` 开头的 Kitto 行，保留其他条目、注释和 `!!js`。当前只同步 stdio `command`/`args`，以及 URL（未声明 `type`，或 `type` 为 `http`/`streamable-http`）；`env`/`headers` 只接受完整 `${VAR}`/`Bearer ${VAR}` 引用，字面值整条 skip；private/local 只在 `--include-private` 时纳入。`${VAR}` 出现在 `url`/`command`/`args`、URL userinfo/凭据类 query、SSE 或其他非 `http`/`streamable-http` transport、非法 server 名等情况会 skip 并给出原因。非空 flow-style 顶层 patch、Kitto 行与其他条目混在同一 `insert`、或生成结果无法解析时会中止且不写入；home patch、profile patch 或启用的 `mcp-manager` 已声明同名 `serverName` 时跳过并警告。`desktop` 不同步；`maintain remove` 只删 Kitto 行，patch 不可安全解析时保留并警告。

**下一步 / 验收**：下一步评估安全支持 SSE/其他 transport 的条件，以及更细的降级提示（哪些条目为何没同步、应去哪个原生配置补）。验收：任何新增 transport 前先用真实 DSH 验证加载；写入仍保留所有非 Kitto 行、注释和 `!!js`；失败或冲突不写文件；删除只删 Kitto 自有行；冲突提示包含来源位置但不含 secret；不把用户的 patch 自动改成 block style。

**风险 / 非目标**：DSH patch 语义没有稳定上游契约；SSE/自定义 transport 支持不足会误导用户；不接管 `mcp-manager`，不重排或格式化用户 YAML，不为追求 parity 写入无法安全表达的字段。

### D.7 scope/update 低优先边界

**状态**：部分实现（已知限制已文档化）。下列改进是 TODO，不阻塞其他条目。

**当前行为**：`scope remove` 只改登记，不删规则、skills、宿主适配器或用户文件；路径先按 realpath 规范化，目标不存在（ENOENT/ENOTDIR）时退回字面绝对路径，未登记则退出码 1 且不写文件；与 scoped setup 共用 `.scope-setup.lock`，被占用时报错。限制：如果目标路径的祖先已断开（例如失效的符号链接），realpath 无法得到登记时的 canonical 路径，可能匹配不到；锁冲突只提示“被 setup 占用”，没有残留锁的确认/清理指引。`update` 对丢失的 checkout：记录为普通分支时按该分支重新 clone；`sourceRef` 为 `null`（以远端默认分支初始化）时会重新 clone 远端默认分支；tag 固定、ref 未记录（`undefined`）或远端已删除、本地/远端真正分叉时都在写前拒绝，不猜测。`pendingRuntime` 标记只保存在 `state.json`；维护 `status` 打印原始 state，`versions` 和用户摘要不单独标注它与回退方式。source URL 的 `//user:pass@` 已在 Kitto 自己的控制台消息中脱敏，但 `state.json` 仍需保留原始 URL 以便 clone，外部 Git 命令的错误输出是否脱敏取决于 Git 本身。

**下一步 / 验收**：TODO：统一锁冲突提示（含残留锁的检查/删除指引）；评估祖先路径断开时的匹配策略；评估 tag/ref 的安全重 clone（显式确认或校验提交）；在 `status`/`versions` 中显式展示 pending runtime 和回退方式；统一 source URL 的脱敏范围。验收：每项有回归测试；错误信息含可执行的下一步且不含凭据；不改变 scope 只读登记语义、不自动猜测 tag/ref、不把 pending runtime 当作已验证版本。

**风险 / 非目标**：自动猜测 ref 可能检出错误提交；锁清理不当会引入并发写；这些是低优先可用性改进，不阻塞 A–C 或 D 的其他条目，也不改变现有错误退出码语义。

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
