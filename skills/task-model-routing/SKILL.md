---
name: task-model-routing
description: Choose or change task models before execution in DSH, Pi, or Codex. Use for role presets, paid routes, model or upstream changes, user disagreements, or an unavailable route.
---

1. Keep the task plan editable. Use the explicit task choice first, then the project role preset, then the current host route for a single-agent task. A preset is a preference, not an authorization. Gather exact native routes and supported effort from this session; a catalog entry is not proof of dispatch, account, billing or data permission.
2. Evaluate the plan with the host adapter below. Show selected routes and ask once about unresolved roles: give the reason, compatible alternatives, their data/charge implications, and “defer”. If an already authorized choice needs no change, do not ask about model selection again. A skipped answer or headless execution without applicable approval leaves that role and its dependants pending. Do not ask the user to construct route JSON or paste credentials.
3. Before launch, record the human's approved runnable scope and recheck the exact routes, effort and work revision. Do not write approvals based on the assistant's recommendation. Change only the relevant choice and reconfirm the affected scope. Support explicit metered approval for this task; an estimate is not a host spending cap. Never launch additional work to diagnose availability and never silently switch or replay a write task.

## Host adapters

- **DSH:** The task-route checker supports `teams` and `subagent`, not the parent session's `current` route. Stage AgentTeams before routing is final; then edit the roster in the native plan. Use `kitto_task_routes` when available or the `kitto` skill's installed CLI. Use `ask_user_question` for decisions the roster cannot capture. Web **Approve & Run** does not invoke the checker: select only a verified native runnable graph. Keep an opted-in one-shot `subagent` permit on its own controlled path.
- **Pi:** Use the loaded extension's `/kitto-route` to inspect a sanitized plan against the current session and `/model` for a manual model change. For one unresolved role, `/kitto-route --choose <plan path>` opens a native picker and returns a preference, not a dispatch approval. For several roles use one conversation question. If an already loaded subagent extension cannot express the requested provider and model, leave that role pending or offer a handoff. Ask in the interactive turn or in an existing approved extension dialog; print/JSON mode cannot ask.
- **Codex:** Use Plan mode `request_user_input` if exposed, otherwise ask once in the conversation. Use `/model` for the parent. Pass an exact `model` and effort to a subagent only if the exposed tool supports them; a model override is not a provider override. Use actual session/thread evidence with the offline checker. Do not modify global provider settings to make a route fit.

For the sanitized payload, native evidence, and the distinction between advisory planning and technical permit enforcement, see [Kitto task model routing](https://github.com/phyzess/kitto/blob/main/docs/model-routing.md).
