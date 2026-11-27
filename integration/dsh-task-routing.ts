import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { checkTaskRouteApproval, planTaskRoutes } from '../lib/task-route-plan.ts';
import { routeQuestions } from '../lib/task-route-questions.ts';

export function evaluateDshTaskRoutes(input, session, now = Date.now()) {
  if (input?.host?.kind !== 'dsh' || input.host.session !== session || !session) {
    return { status: 'unavailable', reason: 'native-session-mismatch' };
  }
  if (input.host.surface === 'current') {
    return { status: 'unavailable', reason: 'native-current-route-unverified' };
  }
  if (!Object.hasOwn(input, 'approval')) {
    const result = planTaskRoutes(input, now);
    return { ...result, decisionPrompt: routeQuestions(result) };
  }
  const result = checkTaskRouteApproval(input, input.approval, now);
  if (result.status !== 'approved' || input.host.surface !== 'teams') return result;
  const native = input.host.nativePlan;
  if (native?.phase !== 'staged' || native.session !== session || native.id !== input.id || !Array.isArray(native.tasks) ||
    native.tasks.length !== result.routes.length || new Set(native.tasks.map(row => row?.id)).size !== native.tasks.length) {
    return { status: 'stop', reason: 'team-launch-scope-mismatch' };
  }
  for (const { id, route } of result.routes) {
    const task = native.tasks.find(row => row?.id === id);
    const role = input.roles.find(row => row.id === id);
    if (!task || task.provider !== route.provider || task.model !== route.model || task.effort !== route.effort ||
      task.fallback !== 'none' || task.workRevision !== role.workRevision || !Array.isArray(task.dependencies) ||
      task.dependencies.length !== role.dependencies.length || new Set(task.dependencies).size !== task.dependencies.length ||
      !task.dependencies.every(dep => role.dependencies.includes(dep))) {
      return { status: 'stop', reason: 'team-launch-scope-mismatch', role: id };
    }
  }
  return result;
}

export function registerDshTaskRouting(ctx) {
  ctx.inject(['profileContext', 'tools'], host => {
    const { installAnchor, name } = host.profileContext;
    if (name !== 'web' || !isAbsolute(installAnchor ?? '')) return;
    let defineTool;
    try {
      const require = createRequire(installAnchor);
      if (require('./package.json').name !== '@deepseek-ai/dsh') return;
      ({ defineTool } = require('@deepseek-ai/dsh-tools'));
    } catch { return; }
    if (typeof defineTool !== 'function') return;
    host.tools.register(defineTool({
      name: 'kitto_task_routes',
      description: 'Evaluate DSH task route choices or recheck exact launch approval. Does not launch or guard AgentTeams.',
      parameters: {
        input_json: { type: 'string', required: true, description: 'Sanitized Kitto task-route plan JSON. Include approval only to recheck a human-approved plan. Do not include prompts, credentials or repository content.' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute({ input_json }, exec) {
        if (exec.signal.aborted || input_json.length > 64_000) return JSON.stringify({ status: 'unavailable', reason: 'input-unavailable' });
        try { return JSON.stringify(evaluateDshTaskRoutes(JSON.parse(input_json), exec.agent?.session?.id)); }
        catch { return JSON.stringify({ status: 'invalid', reason: 'invalid-plan-json' }); }
      },
    }));
  });
}
