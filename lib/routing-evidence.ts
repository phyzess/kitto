import { fresh } from './go-allowance.ts';
import { routeId, routeKey } from './routing-policy.ts';
import type { Json } from '../types/kitto.d.ts';

export const EVIDENCE_TTL = 300_000;
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export const exactRoute = (row: Json | null | undefined): boolean =>
  routeId(row?.provider) && !row.provider.includes('/') && routeId(row.model);
const uniqueEfforts = (list: unknown): boolean =>
  Array.isArray(list) && list.every((item: string) => EFFORTS.has(item)) && new Set(list).size === list.length;

export function parseNativeModelResult(route: Json, value: unknown): string[] | null {
  if (!exactRoute(route) || typeof value !== 'string' || value.length > 8192 || /[\x00-\x09\x0b-\x1f\x7f]/.test(value)) return null;
  const [title, heading, ...lines] = value.split('\n');
  const prefix = `${routeKey(route)} — `;
  if (!title.startsWith(prefix) || !title.slice(prefix.length).trim() || heading !== 'Reasoning efforts:' || !lines.length) return null;
  if (lines.length === 1 && lines[0] === '(no advertised reasoning efforts)') return [];
  const rows = lines.map((line: string) => /^([a-z]+)( \(default\))? — \S.*$/.exec(line));
  if (rows.some((row) => !row) || rows.filter((row) => row![2]).length > 1) return null;
  const ids = rows.map((row) => row![1]);
  return uniqueEfforts(ids) ? ids : null;
}

export function applyCapabilityEvidence(host: Json | null | undefined, now: number): Json | null | undefined {
  if (!host || !Object.hasOwn(host, 'evidence')) return host;
  const { evidence, session, profile, routes, surface } = host;
  if (!Array.isArray(routes)) return host;
  const entries = new Map<string, unknown>();
  if (
    routeId(session) &&
    evidence?.session === session &&
    evidence.profile === profile &&
    Array.isArray(evidence.routes) &&
    evidence.routes.length <= 64 &&
    ['dsh-observer', 'operator-native-result'].includes(evidence.source)
  ) {
    for (const row of evidence.routes) {
      if (!exactRoute(row)) continue;
      const key = routeKey(row);
      const efforts = evidence.source === 'dsh-observer' ? row.reasoningEfforts : parseNativeModelResult(row, row.result);
      entries.set(key, !entries.has(key) && fresh(row.observedAt, now, EVIDENCE_TTL) && uniqueEfforts(efforts) ? efforts : null);
    }
  }
  return {
    ...host,
    routes: routes.map((route: Json) => {
      const efforts = exactRoute(route) && entries.get(routeKey(route));
      const available = route?.available === true || (surface === 'subagent' && exactRoute(route) && !Object.hasOwn(route, 'available'));
      return efforts && available ? { ...route, reasoningEfforts: efforts, available: true } : { ...route, available: false };
    }),
  };
}
