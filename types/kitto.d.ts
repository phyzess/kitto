export type HostName = 'pi' | 'codex' | 'dsh';
export type OwnershipKind = 'skill' | 'instructions' | 'mcp' | 'pi-package';
export type OwnershipStatus = 'owned' | 'pending' | 'kept';

export interface OwnershipEntry {
  hash: string | null;
  status: OwnershipStatus;
  previous?: string;
  spec?: unknown;
}

export type OwnershipScope = Record<string, OwnershipEntry>;
export type OwnershipLedger = Partial<Record<OwnershipKind, Record<string, OwnershipScope>>>;

export interface MigrationRecord {
  from: 1;
  present: string[];
  pi: { imported: boolean };
}

export interface State {
  schema: 1 | 2;
  source: string;
  agents: HostName[];
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
  [key: string]: unknown;
}

export interface StateV1 extends Omit<State, 'schema' | 'owned' | 'migration'> {
  schema?: 1;
  skills?: Record<string, string>;
  hostSkills?: Record<string, Record<string, string>>;
  keptSkills?: Record<string, string[]>;
  instructions?: Record<string, string>;
  mcp?: { codex?: Record<string, string>; codexPending?: Record<string, string>; [key: string]: unknown };
}

export interface MigrationResult {
  state: State;
  changed: boolean;
  removable: string[];
}

export type HostActionPhase = 'sync' | 'post-skills' | 'connect' | 'detach';

export interface PreviewOptions {
  announce?: boolean;
}

export interface HostAction {
  host: HostName;
  kind: string;
  phase?: HostActionPhase;
  describe(): string;
  preview(options?: PreviewOptions): Promise<unknown>;
  apply(): Promise<unknown>;
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
  common?: Record<string, unknown>;
  pi?: Record<string, unknown>;
  codex?: Record<string, unknown>;
  dsh?: Record<string, unknown>;
}
