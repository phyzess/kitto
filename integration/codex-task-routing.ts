import { checkTaskRouteApproval, planTaskRoutes } from '../lib/task-route-plan.ts';
import { routeQuestions } from '../lib/task-route-questions.ts';
import { resolveTaskRoutes } from '../lib/routing-resolver.ts';
import { readProbeCache } from '../lib/routing-pool-health.ts';
import { kittoHome } from '../lib/kitto-home.ts';
import type { PlanInput, TaskRouteEvaluation } from '../lib/task-route-plan.ts';
import type { ResolvePlanInput } from '../lib/routing-resolver.ts';
import type { ProbeSnapshot } from '../lib/routing-probe.ts';

interface CodexNative {
  thread?: { id?: string };
  modelProvider?: string;
  model?: string;
  reasoningEffort?: string;
  spawnParameters?: unknown;
}

export function evaluateCodexTaskRoutes(input: PlanInput, now: number = Date.now()): TaskRouteEvaluation {
  const host = input?.host,
    native = (host as { native?: CodexNative } | undefined)?.native;
  if (
    host?.kind !== 'codex' ||
    !native?.thread?.id ||
    native.thread.id !== host.session ||
    typeof native.modelProvider !== 'string' ||
    typeof native.model !== 'string' ||
    !Array.isArray(host.routes)
  ) {
    return { status: 'unavailable', reason: 'codex-native-thread-unverified' };
  }
  const current = { provider: native.modelProvider, model: native.model };
  const params = native.spawnParameters;
  const overrideModel = Array.isArray(params) && params.includes('model');
  const overrideEffort = Array.isArray(params) && params.includes('reasoning_effort');
  const routes = host.routes.map((route) => {
    const providerMatches = route.provider === current.provider;
    const currentMatches = providerMatches && route.model === current.model;
    if (host.surface === 'current')
      return { ...route, nativeSelectionRequired: !currentMatches, nativeEffort: currentMatches ? native.reasoningEffort : undefined };
    return {
      ...route,
      dispatchable: route.dispatchable === true && providerMatches && (currentMatches || overrideModel),
      efforts: overrideEffort ? route.efforts : [],
    };
  });
  const plan = { ...input, host: { ...host, current, routes } };
  const resolveRequest = plan as unknown as ResolvePlanInput;
  if (resolveRequest.mode === 'resolve' && !Object.hasOwn(input, 'approval')) {
    const resolved = resolveTaskRoutes(resolveRequest, {
      probe: resolveRequest.probe ?? readProbeCache<ProbeSnapshot>(kittoHome(), now),
      now,
    });
    return { ...resolved, decisionPrompt: routeQuestions(resolved) } as unknown as TaskRouteEvaluation;
  }
  if (Object.hasOwn(input, 'approval')) return checkTaskRouteApproval(plan, input.approval, now);
  const result = planTaskRoutes(plan, now);
  return { ...result, decisionPrompt: routeQuestions(result) };
}
