#!/usr/bin/env node
import { setup, parseOptions } from '../lib/kitto.mjs';

const help = `Kitto — portable personal agent configuration

  kitto setup [--agents pi,codex,dsh] [--source PATH_OR_GIT_URL] [--ref BRANCH]
              [--dsh-profile PROFILE] [--install-agents] [--dry-run]
  kitto setup --recover [--dry-run]   Restore the last working Kitto code

Global user setup only. Defaults to installed agents and phyzess/kitto.
After setup, start your agent with its native command and ask the Kitto skill
to inspect, sync or update your configuration. No project initialization.
Kitto needs Node >=22 and Git. Pi sync also needs Bash and Python >=3.10.
DSH needs pnpm and uses the web profile by default. Host CLIs have their own Node requirements.
`;
try {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') console.log(help);
  else if (command === 'setup') await setup(parseOptions(args));
  else throw new Error(`Unknown command: ${command}. Use kitto --help.`);
} catch (error) {
  console.error(`Kitto: ${error.message}`);
  process.exitCode = 1;
}
