---
name: dsh-delivery-audit
description: 当 DSH AgentTeams 的 workspace audit 报 disposed、Delivery 无法核验，或已审文件在 workspace snapshot 中缺失时，区分宿主审计、工作树与候选证据。
---

在**原团队会话**取一次 `agent_teams_status`，只摘取当前任务的 review verdict、Delivery、审计错误及取样时间。先按证据分流：

| 观察 | 下一步 | 何时停止 |
|---|---|---|
| 无法读取原团队或没有审计结果 | 记为「未核验」，指出缺哪个任务的原始结果 | 不从另一个会话的空状态推断通过 |
| 当前审计错误为 `workspace audit service was disposed` | 记为「宿主审计不可用」，保留原团队和候选；若另有快照缺文件，分别记录 | Web 在线、日志无匹配或 Git 一致都不能消除此错误。无需重跑实现或全套测试 |
| 快照缺文件，但没有上述错误 | 分别在已知的建队目录和实际候选目录运行下方命令；将路径、提交和被审版本并排比较 | 不同目录即使 HEAD 相同也可能有不同未提交内容；路径相同但仍缺文件，记录「快照绑定未确认」，不猜根因 |
| 原团队已能对当前候选给出完整 Delivery | 回到项目原有评审与 CI 入口 | 只解除本项审计阻塞，不替代评审或合并授权 |

```sh
git rev-parse --show-toplevel
git rev-parse --verify HEAD
git --no-optional-locks status --short --untracked-files=normal
```

当前 shell 的 cwd 不是建队目录的证明。目录不可观察就标「未知」。以上命令不修改候选，不证明未提交字节相同；需要对账时从原评审记录取 tree 或 patch 指纹，分开列出未跟踪文件。只交接「宿主状态 / 候选版本 / 缺失证据 / 下一步负责人」，不转发完整状态、路径清单或日志。

宿主故障保留给维护者。不要修改 `.agent-teams`、重派同一任务、重启共享服务或应用历史补丁来制造通过；需要恢复或特例放行，按本次工单单独取得授权。