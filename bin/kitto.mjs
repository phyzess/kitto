#!/usr/bin/env node
import { resolve } from 'node:path';
import { setup, parseOptions } from '../lib/kitto.mjs';
import { readScopeRegistry, scopeHome, writeScopeRegistry } from '../lib/scopes.mjs';

const help = `Kitto — portable personal agent configuration

  kitto setup                 Guided setup in an interactive terminal
  kitto setup --interactive   Start the setup wizard explicitly
  kitto setup --workspace-parent PATH [--agents pi,codex,dsh] [--dry-run]
  kitto setup --global [--agents pi,codex,dsh] [--dry-run]
  kitto setup --workspace PATH [--agents pi,codex,dsh] [--dsh-service UNIT] [--dry-run]
  kitto setup [--agents pi,codex,dsh] [--source PATH_OR_GIT_URL] [--ref BRANCH_OR_TAG]
              [--dsh-profile PROFILE] [--install-agents] [--dry-run]
  kitto setup --recover [--dry-run]   Restore the last working Kitto code
  kitto scope list [--json]   Show global, workspace and workspace-parent scope registrations
  kitto scope remove --global
  kitto scope remove --workspace PATH
  kitto scope remove --workspace-parent PATH

Scoped setup shares AGENTS.md and .agents/skills. Plain setup uses the phyzess/kitto configuration repository.
After scoped setup, edit the shared files and start a new native agent session.
Plain setup installs the Kitto maintenance skill for configuration synchronization.
Kitto needs Node >=22 and Git. Pi sync also needs Bash and Python >=3.10.
DSH needs pnpm and uses the web profile by default. Host CLIs have their own Node requirements.
Scope removal only changes the scope registry; AGENTS.md, skills, host adapters and user files stay in place.
`;

const scopeHelp = `Kitto scope registry

  kitto scope list [--json]             List registered global, workspace and workspace-parent scopes
  kitto scope remove --global           Unregister the global scope
  kitto scope remove --workspace PATH   Unregister one workspace
  kitto scope remove --workspace-parent PATH
                                        Unregister one workspace parent

kitto scope remove only changes the scope registry. It keeps AGENTS.md, .agents/skills,
host adapters, hooks, symlinks and profile patches. Choose exactly one removal target.
A relative PATH is resolved from the current directory and compared with the registered path.
`;

function formatScopeList(registry) {
  const section = paths => paths.length ? paths.map(path => `  ${path}`) : ['  (none)'];
  return [
    `Global: ${registry.global ? 'enabled' : 'disabled'}`,
    'Workspaces:', ...section(registry.workspaces),
    'Workspace parents:', ...section(registry.workspaceParents),
  ].join('\n');
}

function parseScopeRemove(args) {
  const targets = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--global') targets.push({ global: true });
    else if (arg === '--workspace' || arg === '--workspace-parent') {
      if (!args[i + 1] || args[i + 1].startsWith('-')) throw new Error(`Missing path for ${arg}.`);
      targets.push({ kind: arg.slice(2), value: args[++i] });
    } else throw new Error(`Unknown scope remove option: ${arg}.`);
  }
  if (targets.length !== 1) throw new Error('Choose exactly one of --global, --workspace PATH or --workspace-parent PATH.');
  return targets[0];
}

async function removeScope(args) {
  const target = parseScopeRemove(args);
  const home = scopeHome();
  const registry = await readScopeRegistry(home);
  if (target.global) {
    if (!registry.global) throw new Error('Global scope is not registered.');
    await writeScopeRegistry(home, { ...registry, global: false });
    console.log('Removed global scope registration. Instructions, skills and host adapters were left in place.');
    return;
  }
  const workspace = target.kind === 'workspace';
  const key = workspace ? 'workspaces' : 'workspaceParents';
  const path = resolve(target.value);
  const registered = registry[key] ?? [];
  if (!registered.includes(path)) {
    throw new Error(`No ${target.kind} scope registered at ${path}. Run kitto scope list to see registered paths.`);
  }
  await writeScopeRegistry(home, { ...registry, [key]: registered.filter(entry => entry !== path) });
  console.log(`Removed ${target.kind} scope registration: ${path}. Instructions, skills and host adapters were left in place.`);
}

async function scopeCommand(args) {
  const [operation, ...rest] = args;
  if (!operation || operation === '--help' || operation === '-h') {
    console.log(scopeHelp);
    return;
  }
  if (operation === 'list') {
    if (rest.length && (rest.length !== 1 || rest[0] !== '--json')) throw new Error('scope list accepts only --json.');
    const registry = await readScopeRegistry(scopeHome());
    const normalized = {
      ...registry,
      workspaces: [...registry.workspaces],
      workspaceParents: [...(registry.workspaceParents ?? [])],
    };
    console.log(rest.length ? JSON.stringify(normalized, null, 2) : formatScopeList(normalized));
    return;
  }
  if (operation === 'remove') return removeScope(rest);
  throw new Error(`Unknown scope command: ${operation}. Use kitto scope --help.`);
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') console.log(help);
  else if (command === 'scope') await scopeCommand(args);
  else if (command === 'setup') {
    if ((args.length === 0 && process.stdin.isTTY && process.stdout.isTTY) ||
        (args.length === 1 && args[0] === '--interactive')) {
      const { runWizard } = await import('../lib/setup-wizard.mjs');
      await runWizard();
    } else await setup(parseOptions(args));
  }
  else throw new Error(`Unknown command: ${command}. Use kitto --help.`);
} catch (error) {
  console.error(`Kitto: ${error.message}`);
  process.exitCode = 1;
}
