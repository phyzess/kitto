import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { sameLocation } from './paths.ts';
import { kittoHome } from './kitto-home.ts';
import { createRoutingStore } from './routing-state.ts';
import type { PoolReleaseRequest, QuotaFailureEvidence } from './routing-state.ts';

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
  'Usage: kitto route plan|check --input FILE\n       kitto route go-metadata --input FILE --allow-network\n       kitto route permit|record-quota|release-pool --input FILE --operator\n       kitto route migrate --home DIRECTORY\nSupply sanitized JSON without prompts or credentials. Only go-metadata can access the network.';
const operatorCommands = ['permit', 'record-quota', 'release-pool'];

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
