import { createHash } from 'node:crypto';

export function packageKey(item) {
  let source = typeof item === 'string' ? item : item?.source ?? '';
  if (source.startsWith('npm:')) {
    const spec = source.slice(4);
    if (spec.lastIndexOf('@') > 0) source = `npm:${spec.slice(0, spec.lastIndexOf('@'))}`;
  } else if (source.startsWith('git:github.com/') || source.startsWith('https://github.com/')) {
    const repo = source.split('github.com/')[1].split('@')[0].replace(/\.git$/, '');
    source = `github.com/${repo}`;
  }
  return source;
}

export const packageHash = spec => createHash('sha256').update(JSON.stringify(spec)).digest('hex');
