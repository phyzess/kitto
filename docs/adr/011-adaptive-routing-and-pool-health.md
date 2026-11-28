# ADR 011: Adaptive routing pre-flight and multi-pool health

Status: proposed.

## Context

Task routing grew in two parallel halves. `lib/task-route-plan.ts` decided which role may run where, `lib/model-routing.ts` carried the route fields, and each host adapter re-derived cost and eligibility its own way. Three consequences followed:

- Route cost and capability were evaluated without a shared catalog, so the same route could be priced or tiered differently depending on the entry point.
- Quota holds existed only for paid Go pools (`recordQuota`/`releasePool` in `lib/routing-state.ts`), keyed on a one-use permit. A Codex, Anthropic, DeepSeek or OpenRouter pool could be exhausted, rate-limited or auth-broken while the checker still offered it.
- Where a multiplier did exist it was applied as a worst-case constant. Nobody could see that DeepSeek's 2x window had just closed, so the plan kept paying peak prices, and nobody could see a 5h window about to trip, so a run died mid-flight instead of moving to another authorized pool.

ADR 007 requires every new defensive branch to name the threat it addresses. That is why honest probing, bounds and fail-closed ledger reads are decisions here, not incidental code.

## Decision

1. **One resolver.** `resolveTaskRoutes` in `lib/routing-resolver.ts` owns candidate eligibility, scoring, fallback chains and the approval key. `kitto route resolve` and the DSH/Pi/Codex adapters call it with the same input shape; a host adapter adds native evidence, not selection logic. Row status is `ready`, `auto-rerouted`, `decision-required`, `unavailable` or `deferred`.
2. **Three honest probe layers.** `lib/routing-probe.ts` treats upstreams differently instead of pretending one mechanism covers all. `opencode-go` (official usage), `deepseek-official` (balance) and `openrouter` (key credit) get an active, zero-inference `GET` only under `--allow-network`. `openai-codex` and `anthropic` have no zero-inference quota endpoint, so they are passive: the local ledger plus an optional local burn-rate comparison against `poolSoftBudgets` in `$KITTO_HOME/routing-profiles.json`. Probe failure stays visible as `probe-error`/`probe-timeout`; a credential rejection records `auth-broken` rather than health.
3. **UTC pricing windows.** `lib/routing-pricing.ts` holds the schedule as data. The built-in `deepseek-peak-utc` schedule prices Monday–Friday `01:00-04:00` and `06:00-10:00` UTC at 2x and everything else at 1x, with weekends labelled separately. A 15 minute boundary buffer and the role's `expectedDurationMinutes` decide `entering-peak-window-soon`. Holidays are conservative: Kitto ships no calendar, so a date counts as off-peak only when the owner lists it in `holidayOverrides`. Long-context pricing switches at the catalog's `longContextThreshold` instead of blending rates.
4. **Same-boundary failover, fail-closed gates.** A row may be rerouted without a question only when the replacement stays inside an already authorized `subscription` or `go-included` route with a verified account and an allowed data class. Metered spend, premium tier, unverified account or billing, an unconfirmed data policy, native-only selection and a native effort mismatch all become `decision-required` with one reason. Any reroute records `rerouteReason`, and `auto-rerouted` rows are never silent.
5. **Hot-cache stickiness.** `sessionStickyRoute` biases the running session's current route so a long cached run is not re-modelled the moment a peak window opens. The switch happens at delivery, handoff, or a hard limit.
6. **Aggregate Go headroom.** Per Go pool, the resolver sums every role it just assigned (`maxMonthlyGoFraction`, else estimated USD over the pool's monthly allowance) and moves the lowest-priority roles away when the sum exceeds `meter.remaining`, with reason `pool-headroom-reallocated`.
7. **Multi-pool health ledger.** `lib/routing-pool-health.ts` generalizes the Go-only hold to any supported upstream, with `report-failure`, `clear-pool`, a probe cache, and `needs-reprobe` after a declared reset.

## ADR 007 threat model mapping

| Guard | ADR 007 in-scope threat |
| --- | --- |
| 0600 files written through a temp file + `rename`, fsynced directory, `O_NOFOLLOW` reads, per-pool directory locks in `lib/routing-pool-health.ts` | Concurrent Kitto runs — two runs, or a run and an interrupted run, must not interleave writes |
| Refusing a ledger that is not owned, too large, unparseable or holding a foreign pool/upstream identity | Host state corruption — a failed or partial deployment must not leave a host unusable |
| Secret-like key rejection in `$KITTO_HOME/routing-profiles.json` and probe output that carries only normalized health plus sanitized reasons (no response body, no credential) | Credential leakage into synced repositories |
| Bounded probe: `GET` only, `redirect: 'error'`, `credentials: 'omit'`, 5 s ceiling, 512 KiB cap, no retry, credential read only from the documented environment variable and matched against a strict character class | Environmental variance, and worktree/runtime mistakes by the owner or their agents — a slow or misconfigured upstream must degrade to a warning, never to a wrong dispatch |
| Fail-closed read: corrupt record, `observedAt` more than 60 s in the future, or a leftover lock directory yields `pool-health-state-invalid`/`needs-reprobe` and the route is rejected | Worktree and runtime mistakes by the owner or their agents |
| Conservative holiday handling and an explicit hold that does not expire on local clock alone | Same two threats: a guess must not be presented as evidence |

No guard here maps to an out-of-scope threat. Kitto still does not defend against a malicious local user, a tampered host binary, or an adversary writing into `$KITTO_HOME` deliberately; that would require amending ADR 007.

## Consequences

- `probe` and `resolve` are advisory. They do not reserve quota, cancel in-flight work, cap spend at the provider, or replace the host's native dispatch. A hold without a declared reset needs an operator `clear-pool`.
- The probe is only as honest as its layer: passive pools report the ledger and an optional local burn-rate, never upstream truth, and the snapshot says so through `probeMode`.
- Scoring is deterministic for a given snapshot, clock and policy, so a preview and an apply built from one plan agree.
- A wrong pricing assumption is now a data change (schedule, `holidayOverrides`, catalog pricing) rather than a code change, and the snapshot exposes the window that was used.

## Verification

- `npx vp test run tests/routing-pricing.test.ts tests/routing-probe.test.ts tests/routing-resolver.test.ts tests/routing-state.test.ts tests/task-route-plan.test.ts tests/task-route-hosts.test.ts tests/model-routing.test.ts tests/go-metadata.test.ts` covers window boundaries, silent reroute disclosure, fail-closed gates, ledger locking and the CLI surface.
- `npm run lint:invariants` keeps path comparison and structured-config parsing inside the shared helpers this ADR depends on.
