---
name: jev-decide
description: 结构化判断：需要在多个选项或阈值之间做一次可记录的判定时使用，比如工单分级、diff 是否触碰风险面、失败是环境还是代码、finding 该判什么 severity、某任务要不要加第三意见。用 JEV 决策模型返回概率与置信度，不生成文本。
---

# jev-decide

JEV 是 System One 决策模型：给它一段 `state`（摘要），加一组**带类型的问句**，它返回每个问句的取值与概率，不生成正文。价格 $0.042/M 输入、输出免费；`jev-1.13-free` 目前免费。

**它不是 agent，也不是审查者**：没有工具、没有长输出。适合做一次可记录的判定，不适合替代实现、审查或需要理由的分析。

## 三个问句类型

| type | 返回 | 用在 |
| --- | --- | --- |
| `noul` | `noul: 0–1` 概率 | 是/否：是否环境问题、是否触碰风险面、是否需要第三意见 |
| `choice` | `choice: <label>` + `probabilities` | 多选一：T0/T1/T2、失败归因、finding 严重度档位 |
| `score` | 档位分值 | 有序评估：改动风险、证据充分度 |

## 用法

```sh
# state 用文件，问句用 JSON
~/.agents/bin/kitto-node ~/.agents/skills/jev-decide/scripts/jev.ts \
  --state @/tmp/state.md --questions @/tmp/q.json

# 内联
~/.agents/bin/kitto-node ~/.agents/skills/jev-decide/scripts/jev.ts --state "只改 docs/README.md；CI 的 static-quality 步骤在提交前的同 SHA 上通过" \
  --questions '{"env":{"type":"noul","instructions":"这次失败更像环境问题而不是改动引起的吗？"}}'
```

`--state` 和 `--questions` 都接受内联值、`@文件` 或 `@-`。只给其中一项用 `@-`（stdin），另一项用内联值或 `@文件`；两项都用 `@-` 会立即以状态码 `2` 退出。

问句示例（一个请求里可以问多个，JEV 并行评估）：

```json
{
  "tier": {
    "type": "choice",
    "instructions": "这次改动属于哪一档？",
    "criteria": { "docs": "只改文档或注释", "logic": "行为变更但无风险面", "risk": "触碰 schema、鉴权、支付、迁移或并发" }
  },
  "env": { "type": "noul", "instructions": "失败更像环境问题吗？" }
}
```

返回：

```json
{ "answers": { "tier": { "type": "choice", "choice": "docs", "confidence": 1, "probabilities": { "docs": 1, "logic": 0, "risk": 0 } },
               "env":  { "type": "noul", "noul": 0.74 } } }
```

## 用在哪

1. **开工分级**：拿工单标题、inScope、diff 统计问 T0/T1/T2，替代凭印象拍板；和人工判断冲突时以人的结论为准，但把分歧记下来。
2. **CI 失败归因**：环境 / 偶发 / 真实回归。概率 > 0.7 才直接重跑，否则按真实失败处理。
3. **风险面判定**：diff 是否触碰 schema、鉴权、支付、迁移、并发——决定要不要升 T2、要不要换模型审查。
4. **finding 分档**：把审查发现按 blocker/high/medium/low 归类，减少主观漂移。
5. **要不要加人**：这次审查是否需要第三意见（`noul`），避免为小改动拉满团队。
6. **会话收口判断**：当前证据是否够交付，还是继续挖。

## 纪律

- **state 放摘要**：改动文件清单、验收要求、错误行、上一轮结论。不放整份源码、日志全文或私有样本；免费模型的数据留存政策没有 ZDR 承诺。
- **一次问完**：多个问句放同一个请求，比逐个问便宜也更快。
- **概率不是结论**：`noul` 低于 0.6 视为不确定，按保守方向走（默认升级、默认按真实失败处理）。
- **可核对**：把返回的 answers 抄进报告或任务输出，别只写「JEV 认为」。
- **失败就退**：脚本非 0 退出时不重试，按人类判断继续；JEV 是加速器，不是门禁。

## 计费与凭据

- 端点用 Go 渠道：`https://opencode.ai/inference/go/systemone/v1/systemone`，`jev-1.14`、`gpt-6-luna-decision`、`gemini-decision-1` 都从这里走，计入 Go 订阅额度（返回里 `billing_source: "go"`）。
- 同一模型走 `https://opencode.ai/inference/systemone/v1/systemone` 则是 Console 按量计费，余额为零时返回 402。用错端点会误以为「Go 不覆盖 System One」。
- `jev-1.13-free` 免费，但数据条款不承诺零留存，只用来做无敏感信息的判定。
- 凭据优先级：环境变量 `OPENCODE_API_KEY` → 环境变量 `OPENCODE_GO_API_KEY` → DSH v1 `refs.OPENCODE_API_KEY` → `refs.OPENCODE_GO_API_KEY`。DSH 回退使用 `DSH_INSTALL_DIR` 指向的宿主自带解析器，读取 `$DSH_HOME/.credentials.yaml`（未设 `DSH_HOME` 时用 `~/.dsh/.credentials.yaml`）；文件须为不超过 1 MiB 的普通文件，POSIX 上须由当前用户独占权限（例如 `0600`）。找不到宿主或安全的存储时，显式设置环境变量。
- 请求必须带产品 User-Agent，否则被网关以 Cloudflare 1010 拒绝；脚本已固定该 header。
