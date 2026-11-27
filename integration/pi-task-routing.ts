import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { checkTaskRouteApproval, planTaskRoutes } from '../lib/task-route-plan.ts';
import { routeQuestions } from '../lib/task-route-questions.ts';
import type { Json } from '../types/kitto.d.ts';

export function evaluatePiTaskRoutes(input: Json, context: Json, now: number = Date.now()): Json {
  const { session, current, effort } = context;
  if (input?.host?.kind !== 'pi' || !session || input.host.session !== session) {
    return { status: 'unavailable', reason: 'native-session-mismatch' };
  }
  const same = (a: Json | undefined, b: Json | undefined) => a?.provider === b?.provider && (a?.model ?? a?.id) === (b?.model ?? b?.id);
  const host =
    input.host.surface === 'current' && Array.isArray(input.host.routes)
      ? {
          ...input.host,
          current: current && { provider: current.provider, model: current.id },
          routes: input.host.routes.map((route: Json) => ({
            ...route,
            nativeSelectionRequired: !(current && same(route, current)),
            nativeEffort: current && same(route, current) ? effort : undefined,
          })),
        }
      : input.host;
  const plan = { ...input, host };
  return Object.hasOwn(input, 'approval') ? checkTaskRouteApproval(plan, input.approval, now) : planTaskRoutes(plan, now);
}

export function registerPiTaskRouting(pi: Json): void {
  pi.registerCommand?.('kitto-route', {
    description: 'Check a local Kitto task route plan against this Pi session without changing models or launching work.',
    async handler(args: string, ctx: Json) {
      if (!ctx.hasUI) return;
      const report = (text: string, level = 'info') => ctx.ui.notify(text, level);
      const choose = args.startsWith('--choose ');
      const path = (choose ? args.slice('--choose '.length) : args).trim();
      if (!path) {
        report('Usage: /kitto-route [--choose] <local sanitized plan JSON path>', 'warning');
        return;
      }
      let input: Json;
      try {
        const file = await open(resolve(ctx.cwd, path), 'r');
        try {
          const stats = await file.stat();
          if (!stats.isFile() || stats.size > 64_000) throw new Error('Invalid plan file.');
          const buffer = Buffer.alloc(64_001);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          if (bytesRead > 64_000) throw new Error('Invalid plan length.');
          input = JSON.parse(buffer.toString('utf8', 0, bytesRead));
        } finally {
          await file.close();
        }
      } catch {
        report('Could not read a local Kitto route plan.', 'error');
        return;
      }
      const result = evaluatePiTaskRoutes(input, {
        session: ctx.sessionManager?.getSessionId?.(),
        current: ctx.model,
        effort: typeof pi.getThinkingLevel === 'function' ? pi.getThinkingLevel() : ctx.thinkingLevel,
      });
      const rows = result.rows ?? result.plan?.rows ?? result.routes ?? [];
      report(
        [
          `Route plan: ${result.status}${result.reason ? ` (${result.reason})` : ''}`,
          ...rows.map(
            (row: Json) =>
              `${row.id}: ${row.route ? `${row.route.provider}/${row.route.model} · ${row.route.billing}` : `${row.status}${row.reason ? ` (${row.reason})` : ''}`}`,
          ),
        ].join('\n'),
      );
      if (!choose || Object.hasOwn(input, 'approval')) return;
      const questions = routeQuestions(result);
      if (questions.length > 1) {
        report(questions.map((q: Json) => `${q.question}\n${q.options.map((option: Json) => option.label).join('\n')}`).join('\n\n'));
        return;
      }
      if (questions.length !== 1 || typeof ctx.ui.select !== 'function') return;
      const [question] = questions;
      const answer = await ctx.ui.select(
        question.question,
        question.options.map((option: Json) => option.label),
      );
      const selected = question.options.find((option: Json) => option.label === answer);
      if (selected?.choice && selected.choice !== 'defer') {
        report(
          `Preference for ${question.id}: ${selected.choice.provider}/${selected.choice.model}. Update the task plan before approval.`,
        );
      } else {
        report(`No launch approval for ${question.id}; keep it pending.`);
      }
    },
  });
}
