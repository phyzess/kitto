import type { DeployPlan, HostAction, HostAdapter, MigrationResult, OwnershipEntry, PiAdapter, State } from './kitto.js';
import * as ownership from '../lib/ownership.ts';
import { downgradeState, migrateState } from '../lib/state-schema.ts';
import { loadKittoState } from '../lib/state-io.ts';
import { hostAction, noteAction } from '../lib/hosts/action.ts';
import { adapterFor, planConnect, planDeploy, selectedAdapters } from '../lib/hosts/index.ts';
import { createCodexAdapter } from '../lib/hosts/codex.ts';
import { createDshDesktopAdapter } from '../lib/hosts/dsh-desktop.ts';
import { createDshWebAdapter } from '../lib/hosts/dsh-web.ts';
import { createPiAdapter } from '../lib/hosts/pi.ts';

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
