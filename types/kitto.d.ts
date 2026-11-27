import type { HostAction } from '../lib/hosts/action.ts';
import type { CodexAdapterDeps } from '../lib/hosts/codex.ts';
import type { DshWebAdapterDeps } from '../lib/hosts/dsh-web.ts';
import type { PiAdapterDeps } from '../lib/hosts/pi.ts';
import type { RunFunction } from '../lib/process.ts';
import type { OwnershipLedger } from '../lib/ownership.ts';
import type { MigrationRecord } from '../lib/state-schema.ts';

export type HostName = 'pi' | 'codex' | 'dsh';

export type Json = Record<string, any>;

export interface RoutingBoundary {
  schema: 1;
  mode: 'personal' | 'company' | 'custom' | 'skip';
  routes?: string[];
  identity: string;
  profile: string;
}

export interface RuntimeRecord {
  version: string;
  hash: string;
}

export interface SourceRevision {
  commit: string;
  dirty: boolean;
  detached: boolean;
}

export interface State {
  schema: 1 | 2;
  source: string;
  agents: HostName[];
  version?: string;
  dshProfile?: string;
  piHome?: string;
  codexHome?: string;
  dshHome?: string;
  agentsHome?: string;
  includePrivate?: boolean;
  ready?: boolean;
  detached?: boolean;
  removing?: boolean;
  removedAgents?: string[];
  owned?: OwnershipLedger;
  migration?: MigrationRecord;
  sourceUrl?: string;
  sourceRef?: string | null;
  pendingRuntime?: RuntimeRecord;
  runtimeHash?: string;
  deployed?: SourceRevision;
  keepExistingSkills?: boolean;
  toolNode?: { path: string; version: string; source: 'mise' | 'execPath' };
  routingInstallKind?: 'local' | 'service';
  routingBoundary?: RoutingBoundary;
  [key: string]: unknown;
}

export interface DeployPlan {
  sync: HostAction[];
  postSkills: HostAction[];
}

export interface HostCapabilities {
  plugin?: boolean;
  mcp?: boolean;
}

export interface HostReport {
  name: string;
  baseline: string;
  actual: string | null;
  status: string;
  detail: string;
  meetsBaseline: boolean;
  capabilities: HostCapabilities;
}

export interface HostAdapter {
  name: string;
  desktop?: boolean;
  available(): boolean;
  inspect(): HostReport;
  reportVersion(): void;
  assertConnectable?(): void;
  plan(state: State): HostAction[];
  planConnect(state: State): HostAction[];
  planDetach(state: State): HostAction[] | Promise<HostAction[]>;
}

export interface PiAdapter extends HostAdapter {
  status(state: State): unknown;
  exportConfig(state: State, apply: boolean): unknown;
}

export interface HostAdapterDeps {
  common?: { home?: string; run?: RunFunction };
  pi?: PiAdapterDeps;
  codex?: CodexAdapterDeps;
  dsh?: DshWebAdapterDeps;
}
