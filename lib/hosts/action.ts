import type { HostName } from '../../types/kitto.d.ts';

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

export interface HostActionSpec {
  phase?: HostActionPhase;
  apply: () => Promise<unknown>;
  preview?: (options?: PreviewOptions) => Promise<unknown>;
}

const nothing = async () => {};

export function hostAction(
  host: HostName,
  kind: string,
  description: string,
  { phase = undefined, apply, preview = nothing }: HostActionSpec,
): HostAction {
  return { host, kind, phase, describe: () => description, preview, apply };
}

export const noteAction = (host: HostName, message: string): HostAction =>
  hostAction(host, 'note', message, {
    apply: async () => console.log(message),
    preview: async ({ announce = true }: PreviewOptions = {}) => {
      if (announce) console.log(message);
    },
  });
