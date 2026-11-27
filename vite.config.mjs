import { availableParallelism } from 'node:os';
import { defineConfig } from 'vite-plus';
import { stableNodeImports } from './scripts/stable-node-imports.ts';

export default defineConfig({
  pack: {
    entry: ['bin/*.ts', 'lib/**/*.ts', 'integration/**/*.ts'],
    unbundle: true,
    root: '.',
    format: 'esm',
    platform: 'node',
    target: 'node26',
    outDir: 'dist',
    sourcemap: true,
    clean: true,
    dts: false,
    plugins: [stableNodeImports],
    outExtensions: () => ({ js: '.mjs' }),
    deps: { neverBundle: [/^node:/, '@clack/prompts'] },
    hooks: {
      'build:done': async () => {
        const { assembleDist } = await import('./scripts/build-dist.ts');
        assembleDist();
      },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    isolate: false,
    maxWorkers: process.env.CI ? availableParallelism() : Math.max(1, Math.floor(availableParallelism() / 2)),
    testTimeout: 240_000,
    hookTimeout: 60_000,
  },
});
