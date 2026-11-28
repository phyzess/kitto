import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { sameLocation } from './paths.ts';
import { kittoHome } from './kitto-home.ts';
import { createRoutingStore } from './routing-state.ts';
import { createPoolHealthStore } from './routing-pool-health.ts';
import { isSupportedUpstream } from './routing-catalog.ts';
import { routeId } from './routing-policy.ts';
import { timestamp } from './go-allowance.ts';
import type { PoolReleaseRequest, QuotaFailureEvidence } from './routing-state.ts';
import type { FailureKind, QuotaWindowKind } from './routing-pool-health.ts';
import type { ProbePoolTarget } from './routing-probe.ts';

interface CommandInput extends Record<string, unknown> {
  host?: {
    kind?: string;
    surface?: string;
    session?: string;
    profile?: string;
    native?: { sessionId?: string; model?: string; thinkingLevel?: string };
  };
  approval?: unknown;
}

interface CommandOutput {
  status?: unknown;
  independent?: unknown;
  reason?: unknown;
  advisory?: unknown;
}

const help =
  'Usage: kitto route plan|check --input FILE\n       kitto route go-metadata --input FILE --allow-network\n       kitto route permit|record-quota|release-pool --input FILE --operator\n       kitto route probe [--allow-network] [--pools UPSTREAM[:POOL],...] [--now ISO] [--no-cache] [--json]\n       kitto route report-failure --pool POOL --upstream UPSTREAM --kind quota|rate_limit|outage|auth [--window WINDOW] [--resets-at ISO] [--reason TEXT] [--now ISO]\n       kitto route clear-pool --pool POOL --upstream UPSTREAM [--reason TEXT] [--now ISO]\n       kitto route migrate --home DIRECTORY\nSupply sanitized JSON without prompts or credentials. Only go-metadata and probe --allow-network can access the network.';
const operatorCommands = ['permit', 'record-quota', 'release-pool'];
const probeUsage = 'Usage: kitto route probe [--allow-network] [--pools UPSTREAM[:POOL],...] [--now ISO] [--no-cache] [--json]';
const failureUsage =
  'Usage: kitto route report-failure --pool POOL --upstream UPSTREAM --kind quota|rate_limit|outage|auth [--window WINDOW] [--resets-at ISO] [--reason TEXT] [--now ISO]';
const clearUsage = 'Usage: kitto route clear-pool --pool POOL --upstream UPSTREAM [--reason TEXT] [--now ISO]';
const failureKinds: readonly FailureKind[] = ['quota', 'rate_limit', 'outage', 'auth'];
const quotaWindows: readonly QuotaWindowKind[] = ['5h', 'rolling', 'weekly', 'monthly', 'balance', 'unknown'];

function parseFlags(args: string[], spec: Record<string, 'boolean' | 'value'>, usage: string): Record<string, string | true> {
  const flags: Record<string, string | true> = {};
  for (let index = 0; index < args.length; index++) {
    const token = args[index],
      name = token.startsWith('--') ? token.slice(2) : undefined,
      kind = name === undefined ? undefined : spec[name];
    if (name === undefined || kind === undefined || Object.hasOwn(flags, name)) throw new Error(usage);
    if (kind === 'boolean') {
      flags[name] = true;
      continue;
    }
    const value = args[++index];
    if (value === undefined || value.startsWith('--') || value.length === 0) throw new Error(usage);
    flags[name] = value;
  }
  return flags;
}

function clockFlag(value: string | true | undefined, usage: string): number | undefined {
  if (value === undefined) return undefined;
  const now = timestamp(value);
  if (typeof value !== 'string' || !Number.isFinite(now)) throw new Error(usage);
  return now;
}

function textFlag(value: string | true | undefined, usage: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(usage);
  return value;
}

function verifiedTarget(upstream: string | undefined, pool: string | undefined, usage: string): ProbePoolTarget {
  if (!upstream || !pool || !isSupportedUpstream(upstream) || !routeId(pool)) throw new Error(usage);
  return { pool, upstream };
}

function poolTargets(value: string | true | undefined): ProbePoolTarget[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(probeUsage);
  return value.split(',').map((item: string) => {
    const parts = item.split(':');
    if (parts.length === 1) return verifiedTarget(parts[0], parts[0], probeUsage);
    if (parts.length === 2) return verifiedTarget(parts[0], parts[1], probeUsage);
    throw new Error(probeUsage);
  });
}

async function probeOperation(args: string[]): Promise<void> {
  const flags = parseFlags(
    args,
    { 'allow-network': 'boolean', pools: 'value', now: 'value', 'no-cache': 'boolean', json: 'boolean' },
    probeUsage,
  );
  const pools = poolTargets(flags.pools),
    now = clockFlag(flags.now, probeUsage);
  const { runRoutingProbe } = await import('./routing-probe.ts');
  const snapshot = await runRoutingProbe({
    kittoHomePath: kittoHome(),
    allowNetwork: flags['allow-network'] === true,
    ...(pools !== undefined && { pools }),
    ...(flags['no-cache'] === true && { writeCache: false }),
    ...(now !== undefined && { now }),
  });
  console.log(JSON.stringify(snapshot, null, 2));
}

function reportFailureOperation(args: string[]): void {
  const flags = parseFlags(
    args,
    { pool: 'value', upstream: 'value', kind: 'value', window: 'value', 'resets-at': 'value', reason: 'value', now: 'value' },
    failureUsage,
  );
  const pool = textFlag(flags.pool, failureUsage),
    upstream = textFlag(flags.upstream, failureUsage),
    kind = textFlag(flags.kind, failureUsage);
  const target = verifiedTarget(upstream, pool, failureUsage);
  if (!kind || !(failureKinds as readonly string[]).includes(kind)) throw new Error(failureUsage);
  const window = textFlag(flags.window, failureUsage),
    resetsAt = textFlag(flags['resets-at'], failureUsage),
    reason = textFlag(flags.reason, failureUsage);
  if (window !== undefined && !(quotaWindows as readonly string[]).includes(window)) throw new Error(failureUsage);
  if (resetsAt !== undefined && !Number.isFinite(timestamp(resetsAt))) throw new Error(failureUsage);
  const now = clockFlag(flags.now, failureUsage);
  const record = createPoolHealthStore(kittoHome()).recordFailure(
    {
      pool: target.pool,
      upstream: target.upstream,
      kind: kind as FailureKind,
      ...(window !== undefined && { window: window as QuotaWindowKind }),
      ...(resetsAt !== undefined && { resetsAt }),
      ...(reason !== undefined && { reason }),
    },
    now,
  );
  console.log(JSON.stringify({ status: 'recorded', record }, null, 2));
}

function clearPoolOperation(args: string[]): void {
  const flags = parseFlags(args, { pool: 'value', upstream: 'value', reason: 'value', now: 'value' }, clearUsage);
  const target = verifiedTarget(textFlag(flags.upstream, clearUsage), textFlag(flags.pool, clearUsage), clearUsage);
  const record = createPoolHealthStore(kittoHome()).clearPool(
    target.pool,
    target.upstream,
    textFlag(flags.reason, clearUsage),
    clockFlag(flags.now, clearUsage),
  );
  console.log(JSON.stringify({ status: 'cleared', record }, null, 2));
}

function matchesMetadataHome(savedHome: unknown, explicitHome: string | undefined): boolean {
  const absolute = (path: unknown): path is string => typeof path === 'string' && isAbsolute(path) && !/[\x00-\x1f\x7f]/.test(path);
  if (!absolute(savedHome)) return false;
  const effective = explicitHome?.trim() ? explicitHome : join(homedir(), '.dsh');
  return absolute(effective) && sameLocation(effective, savedHome);
}

export async function routeCommand(args: string[]): Promise<void> {
  if (!args.length || (args.length === 1 && ['-h', '--help'].includes(args[0]))) {
    console.log(help);
    return;
  }
  if (args[0] === 'probe') return probeOperation(args.slice(1));
  if (args[0] === 'report-failure') return reportFailureOperation(args.slice(1));
  if (args[0] === 'clear-pool') return clearPoolOperation(args.slice(1));
  const [operation, flag, path] = args;
  const local = kittoHome();
  const getState = () =>
    readFile(join(local, 'state.json'), 'utf8')
      .then(JSON.parse)
      .catch((): null => null);
  if (operation === 'migrate' && flag === '--home' && path && args.length === 3) {
    const { migrateRouting } = await import('./routing-migration.ts');
    const state = await getState();
    console.log(JSON.stringify(migrateRouting({ home: path, mode: 'preview', activeHomes: [state?.dshHome] }), null, 2));
    return;
  }
  const optedIn = operation === 'go-metadata' && args.length === 4 && args[3] === '--allow-network';
  const operator = operatorCommands.includes(operation) && args.length === 4 && args[3] === '--operator';
  if ((!optedIn && !operator && (args.length !== 3 || !['plan', 'check'].includes(operation))) || flag !== '--input' || !path)
    throw new Error(help);
  let request: CommandInput;
  try {
    if (operator) {
      const stats = await lstat(path);
      if (!stats.isFile() || (stats.mode & 0o077) !== 0 || stats.size > 1_000_000 || (process.getuid && stats.uid !== process.getuid()))
        throw new Error('Private operator file required.');
    }
    request = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('Cannot read routing input as JSON.');
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Routing input must be a JSON object.');
  let output: CommandOutput;
  if (operation === 'plan' || operation === 'check') {
    const input = { ...request };
    if (operation !== 'check') delete input.approval;
    else if (!Object.hasOwn(input, 'approval')) input.approval = null;
    if (input.host?.kind === 'codex') {
      const { evaluateCodexTaskRoutes } = await import('../integration/codex-task-routing.ts');
      output = evaluateCodexTaskRoutes(input);
    } else if (input.host?.kind === 'dsh') {
      const { evaluateDshTaskRoutes } = await import('../integration/dsh-task-routing.ts');
      const nativeSession = process.env.DSH_SESSION_ID;
      output = evaluateDshTaskRoutes(input, operation === 'check' ? nativeSession : nativeSession || input.host.session);
    } else if (input.host?.kind === 'pi' && input.host.surface === 'current' && !input.host.native) {
      output = { status: 'unavailable', reason: 'pi-native-state-unverified' };
    } else if (input.host?.kind === 'pi' && input.host.native) {
      const { evaluatePiTaskRoutes } = await import('../integration/pi-task-routing.ts');
      const { sessionId, model, thinkingLevel } = input.host.native;
      output = evaluatePiTaskRoutes(input, { session: sessionId, current: model, effort: thinkingLevel });
    } else {
      const { planTaskRoutes, checkTaskRouteApproval } = await import('./task-route-plan.ts');
      output = operation === 'check' ? checkTaskRouteApproval(input, input.approval) : planTaskRoutes(input);
    }
  } else {
    const state = await getState();
    const profile = operator ? (request.host?.profile ?? 'web') : request.host?.profile;
    const profileMismatch = process.env.DSH_PROFILE && process.env.DSH_PROFILE !== profile;
    const explicitHome = process.env.DSH_HOME;
    const homeMismatch =
      optedIn || operator
        ? !matchesMetadataHome(state?.dshHome, explicitHome)
        : explicitHome && (typeof state?.dshHome !== 'string' || !sameLocation(explicitHome, state.dshHome));
    if (profileMismatch || homeMismatch) output = { advisory: true, status: 'stop', reason: 'session-configuration-mismatch' };
    else if (operator) {
      const { boundRoutingPolicy, issueRoutePermit } = await import('../integration/dsh-routing.ts');
      const home = explicitHome?.trim() ? explicitHome : join(homedir(), '.dsh');
      if (!boundRoutingPolicy(state, home, profile)) throw new Error('A verified local Web boundary is required.');
      const store = createRoutingStore(local);
      if (operation === 'permit') output = issueRoutePermit({ state, home, request, store });
      else {
        if (operation === 'record-quota') store.recordQuota(request as unknown as QuotaFailureEvidence);
        else store.releasePool(request as unknown as PoolReleaseRequest);
        output = { status: operation === 'record-quota' ? 'pool-held' : 'pool-released' };
      }
    } else {
      const { collectGoMetadata } = await import('./go-metadata.ts');
      output = await collectGoMetadata({ state, request, optedIn });
    }
  }
  console.log(JSON.stringify(output, null, 2));
  const stopped = typeof output.status === 'string' && ['stop', 'invalid', 'pending', 'unavailable'].includes(output.status);
  if (stopped || output.independent === false) process.exitCode = 2;
}
