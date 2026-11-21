## Pi 专属补充

Pi 的 `i-have-adhd` 扩展默认常开（`~/.pi/agent/.i-have-adhd-always`）；扩展不可用时按共享规则的会话开始说明手动加载。

### Pi 能力适配

配置在 `~/.pi/agent/mcp.json`；涉及 wiki/Confluence/Jira/GitLab 时先检查 `/mcp` 的实际连接状态，再决定是否使用，不要仅按配置文件推断可用。

| Server | Tools | 用途 |
|---|---|---|
| atlassian | confluence_search/get_page/create/update…、jira_search/get_issue/create/transition… | RC wiki(wiki.ringcentral.com)与 Jira 工单。产品文档页先 confluence_search 找 pageId 再 get_page(convert_to_markdown: true) |
| gitlab | MR/issue/CI(21 个) | int.rclabenv.com 代码评审/流水线 |
| context7 | 库文档查询 | 依赖/框架最新 API 文档 |
| codegraph | codegraph_*(直连工具) | 代码结构与影响分析(见共享规则的「工具与验证」) |
| dap-debug | lldb/debugpy attach | 断点调试(见共享规则的「改动与调试」) |
| ast-grep | 结构化搜索 | 大规模代码模式检索/改写 |
| chrome-devtools | CDP 级调试 | 仅当 ego-browser 覆盖不了时使用(浏览器任务默认见「浏览器默认」) |

MCP 懒连接并通过代理按需发现工具。subagents 和 hindsight 都是扩展能力：存在且适合当前任务时使用，不可用时按 workspace `AGENTS.md` 降级。

### 浏览器默认

- 浏览器任务(开网页、填表单、点击、截图、提取页面数据、Web 应用测试/QA)默认使用 ego-browser skill：先跑 `ego-browser skill`，再按其指引经 `ego-browser` CLI(ego lite)操作。
- 不要默认用其他自动化工具(如 chrome-devtools MCP)启动 Chrome；仅当任务需要 ego-browser API 覆盖不了的 CDP 级调试时才使用。

### 方案评审(Plannotator)

`plannotator` 工具每个会话都可调用；若它不在工具列表里，直接说明并停下，不要静默跳过评审。

- **触发即调用**：写完或改完方案/设计/规格类文档(`PLAN.md`、`spec*.md`、`docs/**/design*.md`、架构或接口设计说明)后，立刻调用 `plannotator` 工具(`gate: true`)，不要先把全文贴进聊天等口头确认，也不要问"要不要开评审"
- 用户说「评审/批注/看看这个/开评审」时，同样直接调用，不再二次确认
- 只有两种豁免：文档自述为草稿或临时笔记(`*.draft.md`、`tmp/` 下)，或用户当场明确说不用评审
- 只是评审已有文档不必进 plan mode；需要我在批准前不动代码的规划才用 `/plannotator-plan-mode`(或用户按 Ctrl+Alt+P)，写完计划后调 `plannotator_submit_plan`
- 代码改动评审用 `plannotator` 工具的 review(PR/MR 传 URL)；会话阻塞到人给出决定，不得 kill，重跑会恢复草稿
- 评审返回的 feedback 就是本轮指令，立即处理；`approved` 附带的 notes 属建议，不算返工要求

### 图片输入

- **禁止嗅探猜图**：图片只用用户消息明确给出的附件路径、`image="..."` id 或 `<vision_proxy_*>` id；不得扫描 `/tmp`、Downloads 或全盘猜测图片来源。
