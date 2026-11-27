import type { HostAction, HostActionPhase, HostName, PreviewOptions } from '../../types/kitto.js';

export interface HostActionSpec {
  phase?: HostActionPhase;
  apply: () => Promise<unknown>;
  preview?: (options?: PreviewOptions) => Promise<unknown>;
}

export declare function hostAction(host: HostName, kind: string, description: string, spec: HostActionSpec): HostAction;
export declare function noteAction(host: HostName, message: string): HostAction;
