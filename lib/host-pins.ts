import type { HostName } from '../types/kitto.d.ts';

export interface HostPin {
  package: string;
  version: string;
  node?: string;
}

export const hosts: Record<HostName, HostPin> = {
  pi: { package: '@earendil-works/pi-coding-agent', version: '1.5.2', node: '22.19.0' },
  codex: { package: '@openai/codex', version: '0.170.0' },
  dsh: { package: '@deepseek-ai/dsh', version: '0.2.2-rc.2', node: '24.9.0' },
};
export const routingHostVersion = '0.2.2-rc.5';
export const pnpmVersion = '12.21.0';
