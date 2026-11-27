import { hosts, pnpmVersion, routingHostVersion } from '../lib/host-pins.mjs';

const pins = { pnpm: pnpmVersion, routing: routingHostVersion, ...Object.fromEntries(Object.entries(hosts).map(([name, host]) => [name, host.version])) };
const version = pins[process.argv[2]];
if (!version) {
  console.error(`Usage: print-host-pin.mjs <${Object.keys(pins).join('|')}>`);
  process.exit(2);
}
console.log(version);
