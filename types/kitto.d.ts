import type { HostAction } from '../lib/hosts/action.ts';
import type { CodexAdapterDeps } from '../lib/hosts/codex.ts';
import type { DshWebAdapterDeps } from '../lib/hosts/dsh-web.ts';
import type { PiAdapterDeps } from '../lib/hosts/pi.ts';
import type { RunFunction } from '../lib/process.ts';
import type { OwnershipLedger } from '../lib/ownership.ts';
import type { MigrationRecord } from '../lib/state-schema.ts';

export type HostName = 'pi' | 'codex' | 'dsh';

export type Json = Record<string, any>;

export interface RouteRef {
  provider: string;
  model: string;
}

export interface HostRoute extends RouteRef {
  canonicalModel?: string;
  family?: string;
  upstream?: string;
  account?: string;
  accountType?: string;
  billing?: string;
  tier?: number;
  premium?: boolean;
  pool?: string;
  available?: boolean;
  accountVerified?: boolean;
  dataAllowed?: boolean;
  allowedData?: string[];
  efforts?: string[];
  reasoningEfforts?: string[];
  dispatchable?: boolean;
  fallback?: string;
  quotaReady?: boolean;
  estimateUsd?: number;
  nativeSelectionRequired?: boolean;
  nativeEffort?: string;
}

export interface RouteSelection extends RouteRef {
  canonicalModel?: string;
  family?: string;
  upstream?: string;
  account?: string;
  accountType?: string;
  billing?: string;
  premium?: boolean;
  pool?: string;
  data?: string;
  plan?: string;
  role?: string;
  workRevision?: string;
  effort?: string;
  maxUsd?: number;
  kind?: string;
}

export interface EvidenceRoute extends RouteRef {
  observedAt?: string;
  reasoningEfforts?: string[];
  result?: string;
}

export interface CapabilityEvidence {
  source?: string;
  session?: string;
  profile?: string;
  routes?: EvidenceRoute[];
}

export interface HostEvidence {
  kind?: string;
  installation?: string;
  surface?: string;
  session?: string;
  profile?: string;
  observedAt?: string;
  current?: RouteRef;
  routes?: HostRoute[];
  effectiveFallbacks?: unknown[];
  evidence?: CapabilityEvidence;
}

export interface GoMetadataEvidence {
  status?: string;
  source?: string;
  account?: string;
  plan?: string;
  profile?: string;
  catalogObservedAt?: string;
  observedAt?: string;
  catalog?: unknown;
  usage?: unknown;
}

export interface GoEvidence {
  account?: string;
  plan?: string;
  extraUsage?: string;
  pool?: string;
  observedAt?: string;
  metadata?: GoMetadataEvidence;
  lastRequest?: { model?: string; usage?: Record<string, unknown> };
  catalogObservedAt?: string;
  catalog?: unknown;
  usage?: unknown;
}

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

export interface DshPluginContext {
  inject(names: string[], factory: (host: Json) => unknown): void;
  on(event: string, handler: (...args: never[]) => unknown): void;
  get(name: string): Json | undefined;
  skills: { registerProvider(factory: (control: Json) => unknown): void };
  logger: { warn(message: string): void };
  workingDirectory: { ensure(agent: unknown, signal?: AbortSignal): Promise<string> };
  profileContext: Json;
}

export interface PiSessionContext {
  hasUI?: boolean;
  cwd: string;
  ui: { notify(message: string, level?: string): void; select?(...args: unknown[]): Promise<unknown> };
  sessionManager?: { getSessionId?(): string | undefined };
  model?: unknown;
  thinkingLevel?: unknown;
}

export interface PiExtensionApi {
  on(event: 'session_start', handler: (event: unknown, ctx: PiSessionContext) => void): void;
  registerCommand?(name: string, definition: { description: string; handler(args: string, ctx: PiSessionContext): Promise<void> }): void;
  getThinkingLevel?(): unknown;
}
