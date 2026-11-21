---
name: kitto-ticket
description: Draft or refine a self-contained engineering ticket from a request, discussion, or existing issue. Use the target repository's conventions when available; return a draft for review by default.
---

# Draft a ticket

1. **Recover the task.** Extract the requested outcome, affected users or systems, evidence, decisions already made, constraints and exclusions from the conversation and supplied artifacts. Separate observed facts from proposals. Identify the target repository before applying its conventions.
2. **Read local rules first.** In that repository, check applicable agent instructions, contribution or process docs, issue templates/forms and references they point to. Select the template for this kind of work. Read only the relevant paths, contracts, examples or linked issues needed to fill it. Keep its language, sections and required metadata; never borrow labels, commands, policies or example issue IDs from another project. A publishing procedure is not permission to publish.
3. **Write the smallest independently verifiable unit.** Cite concrete paths or links so another session can start without this conversation. State what is in and out, dependencies, the expected behavior and a way to distinguish success from failure. Use repository-required fields where present. If no template applies, start here:

   ```markdown
   # <action and observable outcome>
   ## Context and goal
   ## Scope and exclusions
   ## Constraints and dependencies
   ## Acceptance criteria
   - Given <condition>, when <action>, then <observable result>.
   ## Verification
   - <check or manual scenario and expected evidence>
   ```

4. **Resolve gaps without an intake questionnaire.** Do not ask for anything answered by the user, repo, or artifacts. If a decision changes scope, acceptance or feasibility and cannot be inferred safely, include the useful draft and ask only that specific question. Mark other unknowns as such rather than inventing paths, owners, deadlines, commands or test results. With no blocking unknown, return the draft without questions.
5. **Stop at the draft.** Return the ticket in the conversation. Do not implement it, write files, create/edit issues, change labels or project state, or post comments by default. Perform an external write only when the user explicitly authorizes that action and destination; clarify an ambiguous target first.
