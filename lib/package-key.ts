import { createHash } from 'node:crypto';

export type PiPackageSpec = string | { source?: string; [key: string]: unknown };

export function packageKey(item: PiPackageSpec | null | undefined): string {
  let source: string = typeof item === 'string' ? item : item?.source ?? '';
  if (source.startsWith('npm:')) {
    const spec = source.slice(4);
    if (spec.lastIndexOf('@') > 0) source = `npm:${spec.slice(0, spec.lastIndexOf('@'))}`;
  } else if (source.startsWith('git:github.com/') || source.startsWith('https://github.com/')) {
    const repo = source.split('github.com/')[1].split('@')[0].replace(/\.git$/, '');
    source = `github.com/${repo}`;
  }
  return source;
}

export const packageHash = (spec: unknown): string => createHash('sha256').update(JSON.stringify(spec)).digest('hex');
