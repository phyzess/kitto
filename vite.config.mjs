import { availableParallelism } from 'node:os';
import { defineConfig } from 'vite-plus';
import { stableNodeImports } from './scripts/stable-node-imports.mjs';

export default defineConfig({
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
  test: {
    include: ['tests/**/*.test.mjs'],
    pool: 'forks',
    isolate: false,
    maxWorkers: process.env.CI ? availableParallelism() : Math.max(1, Math.floor(availableParallelism() / 2)),
    testTimeout: 240_000,
    hookTimeout: 60_000,
  },
});
