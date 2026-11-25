import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { kittoHome } from './kitto-home.mjs';
import { adviseRoute, auditReview } from './model-routing.mjs';

const help = 'Usage: kitto route preflight|reselect|audit --input FILE\n       kitto route go-metadata --input FILE --allow-network\nSupply sanitized JSON without prompts or credentials. Only go-metadata can access the network.';

function matchesMetadataHome(savedHome, explicitHome) {
  const absolute = path => typeof path === 'string' && isAbsolute(path) && !/[\x00-\x1f\x7f]/.test(path);
  if (!absolute(savedHome)) return false;
  const effective = explicitHome?.trim() ? explicitHome : join(homedir(), '.dsh');
  return absolute(effective) && resolve(effective) === resolve(savedHome);
}

export async function routeCommand(args) {
  if (!args.length || args.length === 1 && ['-h', '--help'].includes(args[0])) {
    console.log(help);
    return;
  }
  const [operation, flag, path] = args;
  const optedIn = operation === 'go-metadata' && args.length === 4 && args[3] === '--allow-network';
  if ((!optedIn && (args.length !== 3 || !['preflight', 'reselect', 'audit'].includes(operation))) || flag !== '--input' || !path) throw new Error(help);
  let request;
  try { request = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error('Cannot read routing input as JSON.'); }
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Routing input must be a JSON object.');
  let output;
  if (operation === 'audit') {
    output = { advisory: true, ...auditReview(request.implementers, request.reviewer) };
  } else {
    const state = await readFile(join(kittoHome(), 'state.json'), 'utf8').then(JSON.parse).catch(() => null);
    const profileMismatch = process.env.DSH_PROFILE && process.env.DSH_PROFILE !== request.host?.profile;
    const explicitHome = process.env.DSH_HOME;
    const homeMismatch = optedIn ? !matchesMetadataHome(state?.dshHome, explicitHome)
      : explicitHome && (typeof state?.dshHome !== 'string' || resolve(explicitHome) !== state.dshHome);
    if (profileMismatch || homeMismatch) output = { advisory: true, status: 'stop', reason: 'session-configuration-mismatch' };
    else if (optedIn) {
      const { collectGoMetadata } = await import('./go-metadata.mjs');
      output = await collectGoMetadata({ state, request, optedIn });
    } else output = adviseRoute({ state, request, operation });
  }
  console.log(JSON.stringify(output, null, 2));
  if (output.status === 'stop' || output.independent === false) process.exitCode = 2;
}
