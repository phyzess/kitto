import { hosts } from '../host-pins.ts';
import { run } from '../process.ts';
import { meetsBaseline } from '../version-order.ts';
import { adapterFor, selectedAdapters } from './index.ts';

function reportHost(report, requireBaseline) {
  const { name, baseline } = report;
  if (report.status === 'unreadable') {
    console.warn(`kitto: ${name}: could not read its version (${report.detail}); continuing, but its native integration is unverified.`);
  } else if (report.meetsBaseline) {
    console.log(`${name}: ${report.actual} (tested baseline ${baseline})`);
  } else {
    const detail = `${name}: ${report.actual} is older than the tested baseline ${baseline}`;
    if (requireBaseline) throw new Error(`${detail}. Upgrade it with \`kitto hosts --apply\`, or drop --require-baseline.`);
    console.warn(`kitto: ${detail}; continuing and skipping the steps this CLI cannot support. Run \`kitto hosts --apply\` when you want the tested baseline.`);
  }
}

export const availableHost = name => adapterFor({}, name).available();

export function checkSelectedHosts(agents, installAgents, options = {}) {
  const reports = [];
  for (const name of agents) {
    const adapter = adapterFor({}, name);
    if (!adapter.available()) {
      if (!installAgents) throw new Error(`${name} is missing. Install it natively or add --install-agents (pins ${hosts[name].version}).`);
      const requiredNode = hosts[name].node;
      if (requiredNode && !meetsBaseline(process.versions.node, requiredNode)) {
        throw new Error(`Installing ${name} through npm requires Node >=${requiredNode}.`);
      }
      console.log(`Install missing CLI: ${hosts[name].package}@${hosts[name].version}${name === 'dsh' ? ' (prerelease)' : ''}`);
      continue;
    }
    const report = adapter.inspect();
    reports.push(report);
    reportHost(report, options.requireBaseline === true);
  }
  return reports;
}

export function installMissingHosts(agents) {
  for (const name of agents) {
    const adapter = adapterFor({}, name);
    if (adapter.available()) continue;
    run('npm', ['install', '--global', `${hosts[name].package}@${hosts[name].version}`]);
    const report = adapter.inspect();
    if (report.status !== 'found' || report.actual !== hosts[name].version) {
      throw new Error(`${name}: npm finished, but the CLI reports ${report.actual ?? report.status} instead of ${hosts[name].version}. `
        + 'Check PATH and the npm global prefix; Kitto wrote no state.');
    }
    console.log(`${name}: ${report.actual} (installed pinned baseline)`);
  }
}

export function hostCliVersions(state) {
  console.log('Host CLIs (Kitto never upgrades them; use each native manager):');
  for (const adapter of selectedAdapters(state)) adapter.reportVersion();
}
