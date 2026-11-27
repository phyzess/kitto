import { checkTaskRouteApproval, planTaskRoutes } from '../lib/task-route-plan.ts';
import { routeQuestions } from '../lib/task-route-questions.ts';

export function evaluateCodexTaskRoutes(input, now = Date.now()) {
  const host = input?.host, native = host?.native;
  if (host?.kind !== 'codex' || !native?.thread?.id || native.thread.id !== host.session ||
    typeof native.modelProvider !== 'string' || typeof native.model !== 'string' || !Array.isArray(host.routes)) {
    return { status: 'unavailable', reason: 'codex-native-thread-unverified' };
  }
  const current = { provider: native.modelProvider, model: native.model };
  const params = native.spawnParameters;
  const overrideModel = Array.isArray(params) && params.includes('model');
  const overrideEffort = Array.isArray(params) && params.includes('reasoning_effort');
  const routes = host.routes.map(route => {
    if (!route || typeof route !== 'object') return route;
    const providerMatches = route.provider === current.provider;
    const currentMatches = providerMatches && route.model === current.model;
    if (host.surface === 'current') return { ...route, nativeSelectionRequired: !currentMatches,
      nativeEffort: currentMatches ? native.reasoningEffort : undefined };
    return { ...route, dispatchable: route.dispatchable === true && providerMatches && (currentMatches || overrideModel),
      efforts: overrideEffort ? route.efforts : [] };
  });
  const plan = { ...input, host: { ...host, current, routes } };
  if (Object.hasOwn(input, 'approval')) return checkTaskRouteApproval(plan, input.approval, now);
  const result = planTaskRoutes(plan, now);
  return { ...result, decisionPrompt: routeQuestions(result) };
}
