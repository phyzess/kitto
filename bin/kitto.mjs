#!/usr/bin/env node
import { setup, parseOptions } from '../lib/kitto.mjs';

const help = `Kitto — portable personal agent configuration

  kitto setup [--agents pi,codex,dsh] [--source PATH_OR_GIT_URL] [--ref BRANCH]
              [--install-agents] [--dry-run]
  kitto setup --recover [--dry-run]   Restore the last working Kitto code

Global user setup only. Defaults to installed agents and phyzess/pi-config.
After setup, start pi / codex / dsh web normally and ask the Kitto skill
to inspect, sync or update your configuration. No project initialization.
Node >=24.9, Git, Bash and Python >=3.10 are required. Agent login stays native.
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
