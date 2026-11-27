---
name: rule-eval
description: Evaluate a change to agent-rule text before merging, using a scenario table and a dry run.
---

# Rule eval

Use this skill when a change touches product rule text: `config/instructions/common.md`, `config/<host>/AGENTS.md` or `skills/*`. Repeated patching after live acceptance runs (PRs #30 to #32) is the failure this prevents. Do not publish or merge as part of this skill.

## 1. State the intent

Write one sentence: which agent behavior should change, and which should stay the same. If you cannot, stop; the change is not ready.

## 2. Write the scenario table

Put it in the PR description (template section "Rule scenarios"). Include at least three trigger rows and two counter-example rows.

| Situation | Expected first reply or behavior | Counter-example |
| --- | --- | --- |
| The user asks for X in context Y | The agent does A before B | The agent does B without A |

- A situation is something a user would actually type or a state the agent would actually be in.
- The expected behavior is observable in the first reply or first tool call, not a vague attitude.
- A counter-example is a nearby situation where the new rule must not fire, or the old wrong behavior.

## 3. Check claims

Every claim about host behavior, billing or limits in the new text needs a command and host version recorded in the PR. Remove claims you cannot evidence.

## 4. Dry run before merge

- Deploy the changed text to a scratch home, not the real one: apply into a temporary home directory (see `docs/usage.md` for the supported options).
- Run each scenario in a fresh session of a cheap model, or a fresh session of the target host. Use one fresh session per row so earlier rows do not leak in.
- Record per row: the model or host and version, pass or fail, and the first reply excerpt.
- If a row fails, change the text once, then rerun the whole table, not only the failed row. Stop after two rounds and reconsider the design rather than adding more wording.

## 5. Record the outcome

Add the filled table with results to the PR description. Note unrun rows and why. Rule text that was not dry-run must be marked unverified in the PR and CHANGELOG line.

## 6. Keep the text short

Prefer deleting a rule that no scenario needs over adding a clarifying sentence. Do not put repository-development rules into product rule files; those belong in the root `AGENTS.md`.
