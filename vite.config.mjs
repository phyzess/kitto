import { stableNodeImports } from './scripts/stable-node-imports.mjs';

export default {
  pack: {
    entry: ['bin/*.mjs', 'lib/**/*.mjs', 'integration/**/*.mjs'],
    unbundle: true,
    root: '.',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outDir: 'dist',
    sourcemap: true,
    clean: true,
    dts: false,
    plugins: [stableNodeImports],
    outExtensions: () => ({ js: '.mjs' }),
    deps: { neverBundle: [/^node:/, '@clack/prompts'] },
    hooks: {
      'build:done': async () => {
        const { assembleDist } = await import('./scripts/build-dist.mjs');
        assembleDist();
      },
    },
  },
};
