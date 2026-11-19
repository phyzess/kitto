#!/usr/bin/env node
import { setup, parseOptions } from '../lib/kitto.mjs';

const help = `Kitto — portable personal agent configuration

  kitto setup                 Guided setup in an interactive terminal
  kitto setup --interactive   Start the setup wizard explicitly
  kitto setup --workspace-parent PATH [--agents pi,codex,dsh] [--dry-run]
  kitto setup --global [--agents pi,codex,dsh] [--dry-run]
  kitto setup --workspace PATH [--agents pi,codex,dsh] [--dsh-service UNIT] [--dry-run]
  kitto setup [--agents pi,codex,dsh] [--source PATH_OR_GIT_URL] [--ref BRANCH_OR_TAG]
              [--dsh-profile PROFILE] [--install-agents] [--dry-run]
  kitto setup --recover [--dry-run]   Restore the last working Kitto code

Scoped setup shares AGENTS.md and .agents/skills. Plain setup uses the phyzess/kitto configuration repository.
After scoped setup, edit the shared files and start a new native agent session.
Plain setup installs the Kitto maintenance skill for configuration synchronization.
Kitto needs Node >=22 and Git. Pi sync also needs Bash and Python >=3.10.
DSH needs pnpm and uses the web profile by default. Host CLIs have their own Node requirements.
`;
try {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') console.log(help);
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
