const nodeImport = /^import [^;\n]+ from "node:[^"\n]+";$/u;

export function sortNodeImports(code) {
  const lines = code.split('\n');
  const out = [];
  for (let index = 0; index < lines.length;) {
    if (!nodeImport.test(lines[index])) {
      out.push(lines[index++]);
      continue;
    }
    const start = index;
    while (index < lines.length && nodeImport.test(lines[index])) index++;
    out.push(...lines.slice(start, index).sort());
  }
  return out.join('\n');
}

export const stableNodeImports = {
  name: 'kitto-stable-node-imports',
  renderChunk: (code) => ({ code: sortNodeImports(code), map: null }),
};
