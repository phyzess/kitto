import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { routingHostVersion } from '../lib/host-pins.ts';
import { fresh } from '../lib/go-allowance.ts';
import { kittoHome } from '../lib/kitto-home.ts';
import { sameLocation } from '../lib/paths.ts';
import { EVIDENCE_TTL, exactRoute, parseNativeModelResult } from '../lib/routing-evidence.ts';
import { activeRoutingBoundary, routeId, routeKey } from '../lib/routing-policy.ts';
import type { Json, DshPluginContext } from '../types/kitto.d.ts';

interface ObservedRow {
  provider: string;
  model: string;
  reasoningEfforts: unknown;
  observedAt: string;
}

interface ObservedSession {
  session: unknown;
  id: string;
  rows: Map<string, ObservedRow>;
}

export function createRouteObserver({
  profile,
  enabled,
  clock = Date.now,
}: {
  profile: string;
  enabled: () => boolean;
  clock?: () => number;
}) {
  const agents = new WeakMap<object, ObservedSession>();
  function session(exec: Json | null | undefined): ObservedSession | null {
    const agent = exec?.agent;
    if (!agent || typeof agent !== 'object' || !routeId(agent.session?.id) || typeof exec.token !== 'symbol') return null;
    if (!enabled()) {
      agents.delete(agent);
      return null;
    }
    const previous = agents.get(agent);
    if (previous && previous.session === agent.session && previous.id === agent.session.id) return previous;
    const next: ObservedSession = { session: agent.session, id: agent.session.id, rows: new Map() };
    agents.set(agent, next);
    return next;
  }
  return {
    observe(exec: Json, result: Json) {
      if (exec?.name !== 'list_subagent_models' || !exactRoute(exec.arguments) || Object.keys(exec.arguments).length !== 2) return;
      const record = session(exec);
      if (!record) return;
      const { provider, model } = exec.arguments,
        key = routeKey({ provider, model });
      const reasoningEfforts =
        result?.isError === false && !exec.signal?.aborted ? parseNativeModelResult({ provider, model }, result.value) : null;
      record.rows.delete(key);
      if (!reasoningEfforts) return;
      const oldest = record.rows.keys().next();
      if (record.rows.size >= 64 && !oldest.done) record.rows.delete(oldest.value);
      record.rows.set(key, { provider, model, reasoningEfforts, observedAt: new Date(clock()).toISOString() });
    },
    export(exec: Json) {
      const record = exec?.signal?.aborted ? null : session(exec);
      if (!record) return null;
      const now = clock();
      for (const [key, row] of record.rows) if (!fresh(row.observedAt, now, EVIDENCE_TTL)) record.rows.delete(key);
      return { source: 'dsh-observer', profile, session: record.id, routes: [...record.rows.values()] };
    },
  };
}

export function registerRouteEvidence(ctx: DshPluginContext): void {
  ctx.inject(['profileContext', 'tools'], (host: Json) => {
    const { name, home, installAnchor } = host.profileContext;
    if (name !== 'web' || !isAbsolute(installAnchor ?? '') || !isAbsolute(home ?? '')) return;
    let defineTool: any;
    try {
      const require = createRequire(installAnchor);
      const manifest = require('./package.json');
      if (manifest.name !== '@deepseek-ai/dsh' || manifest.version !== routingHostVersion) return;
      ({ defineTool } = require('@deepseek-ai/dsh-tools'));
    } catch {
      return;
    }
    if (typeof defineTool !== 'function') return;
    const enabled = () => {
      try {
        const state = JSON.parse(readFileSync(join(kittoHome(), 'state.json'), 'utf8'));
        return sameLocation(home, state.dshHome) && Boolean(activeRoutingBoundary(state, name));
      } catch {
        return false;
      }
    };
    const observer = createRouteObserver({ profile: name, enabled });
    host.on('tools/result', observer.observe);
    host.tools.register(
      defineTool({
        name: 'kitto_route_evidence',
        description:
          'Export exact list_subagent_models results observed for this agent and session in the last five minutes. No account, credential, or Team fallback verification.',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
        execute: (_args: unknown, exec: Json) => JSON.stringify(observer.export(exec)),
      }),
    );
  });
}
