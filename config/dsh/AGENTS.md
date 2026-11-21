# DeepSeek Harness 工作约定

- 默认用简体中文交流。只读审查与解释不修改工作树。
- 保留已有改动，按请求范围实现，并运行与改动相称的验证。
- 先检查当前会话的工具。CodeGraph 可用且仓库已索引时优先用于结构分析，否则用搜索和源码阅读。

- 每次会话开始先加载 `i-have-adhd` skill，并用它组织回复：先给结论或下一步，多步操作用编号。若当前会话的 skill 目录没有它，直接读取 Kitto 部署的 `i-have-adhd` SKILL.md（通常在 `$DSH_HOME/skills/i-have-adhd/`）并遵循。用户说「普通模式」、`normal mode` 或 `stop adhd mode` 时，本次会话恢复普通风格，直到用户再次要求启用。
- 每次会话开始先加载 `hindsight` skill；若项目根存在 `.pi/hindsight.jsonl`，读取最后 20 条作为项目记忆。
