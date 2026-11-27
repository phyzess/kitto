import type { DeployPlan, HostAction, HostAdapter, MigrationResult, OwnershipEntry, PiAdapter, State } from './kitto.js';
import * as ownership from '../lib/ownership.mjs';
import { downgradeState, migrateState } from '../lib/state-schema.mjs';
import { loadKittoState } from '../lib/state-io.mjs';
import { hostAction, noteAction } from '../lib/hosts/action.mjs';
import { adapterFor, planConnect, planDeploy, selectedAdapters } from '../lib/hosts/index.mjs';
import { createCodexAdapter } from '../lib/hosts/codex.mjs';
import { createDshDesktopAdapter } from '../lib/hosts/dsh-desktop.mjs';
import { createDshWebAdapter } from '../lib/hosts/dsh-web.mjs';
import { createPiAdapter } from '../lib/hosts/pi.mjs';

declare const state: State;

export const entry: OwnershipEntry | undefined = ownership.get(state, 'skill', 'shared', 'name');
export const entries: OwnershipEntry[] = ownership.list(state, 'mcp', 'codex');
export const recorded: string | undefined = ownership.recordedHash(state, 'mcp', 'codex', 'name');
export const migrated: MigrationResult = migrateState(state);
export const downgraded: State = downgradeState(state);
export const loaded: Promise<State> = loadKittoState('home');

export const action: HostAction = hostAction('pi', 'kind', 'description', { phase: 'sync', apply: async () => {} });
export const note: HostAction = noteAction('dsh', 'message');

export const pi: PiAdapter = createPiAdapter();
export const codex: HostAdapter = createCodexAdapter();
export const dshWeb: HostAdapter = createDshWebAdapter();
export const dshDesktop: HostAdapter = createDshDesktopAdapter();
export const adapter: HostAdapter = adapterFor(state, 'codex');
export const adapters: HostAdapter[] = selectedAdapters(state);
export const deploy: DeployPlan = planDeploy(state);
export const connect: HostAction[] = planConnect(state);
