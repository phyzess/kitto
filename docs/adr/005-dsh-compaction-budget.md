# ADR 005: Tune DSH compaction through the model route

Status: accepted (manual operating reference, not deployed by Kitto).

## Context

In a historical 2026-11-19–24 sample, a nominal 1.05M context allowed a session to reach roughly 840K tokens. There were prune events but no summary compaction; 44% of requests exceeded 200K, and the five-day API-equivalent estimate was about $850. The [orchestration report](../orchestration.md#上下文与成本) records the sample and its limits. This is workload evidence, not a current pricing guarantee.

## Decision

Adjust effective capacity on `llm-pi-ai` model routes rather than freezing a stock Web preset just to change `compaction-basic`. Web's preset viewer is read-only, the preset definition does not inherit plugin lists, and overriding the list by ID replaced rather than merged it in the sampled runtime (354 → 322 nodes). An overridden stock list can hide plugins after an upgrade.

The trigger is the smaller of `thresholdRatio × contextWindow` and `contextWindow − maxTokens − headroomTokens`. With `thresholdRatio=0.8`, `headroomTokens=65536`, and a 400,000-token route with 128,000 output tokens, this yields **206,464 tokens**. That is near, but not under, a strict 200K prompt ceiling. For example, a 390,000-token route with the same output limit triggers at 196,464; select margin for your model, workload and actual pricing thresholds. These are reference values, not changes to any installed profile.

## Consequences and verification

Earlier compaction reduces repeated reads but can lose detail. For long read-only checks, aggregate locally and give the session the reduced result instead of relying only on summaries. After an authorized configuration change, restart Web, open a fresh session (routes are snapshotted), and compare p90 prompts using `node ~/.agents/skills/context-budget/scripts/dsh-usage.mjs --days 1`. Check the Context panel or logs for actual summary-compaction events rather than just `compaction/prune`. Treat a p90 near 200K as a comparison target, not proof that each request stays below it. Audit usage from `assistant/message` `usage` records in `session.v4.jsonl.zstd`, not inferred text lengths.
