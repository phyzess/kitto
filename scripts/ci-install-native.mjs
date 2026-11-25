import { execFileSync } from 'node:child_process';
import { hosts, pnpmVersion } from '../lib/kitto.mjs';

const prefix = process.env.RUNNER_TEMP + '/kitto-hosts';
execFileSync('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--ignore-scripts', 'pnpm@' + pnpmVersion,
  ...Object.values(hosts).map(host => host.package + '@' + host.version)], { stdio: 'inherit' });
execFileSync('npm', ['rebuild', '--prefix', prefix, 'pnpm'], { stdio: 'inherit' });
