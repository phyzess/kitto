import { hosts } from '../host-pins.ts';
import { noteAction } from './action.ts';
import type { HostAdapter } from '../../types/kitto.d.ts';

export function createDshDesktopAdapter(): HostAdapter {
  return {
    name: 'dsh',
    desktop: true,
    available: () => true,
    inspect: () => ({ name: 'dsh', baseline: hosts.dsh.version, actual: null, status: 'app-managed', detail: 'app-managed',
      meetsBaseline: false, capabilities: {} }),
    reportVersion: () => console.log(`  dsh: app-managed (Kitto tested baseline ${hosts.dsh.version}); upgrade through DeepSeek Harness Desktop`),
    plan: () => [],
    planConnect: () => [noteAction('dsh', 'DSH desktop profile: app-managed; skipped Kitto bundle registration (global rules and skills only).')],
    planDetach: () => [noteAction('dsh', 'DSH desktop profile is app-managed; Kitto never installed a bundle, patch or MCP home row for it, so no native removal is needed.')],
  };
}
