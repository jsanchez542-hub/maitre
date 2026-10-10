import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const core = (entry: string) => fileURLToPath(new URL(`../src/${entry}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^maitre\/demo$/, replacement: core('demo/index.ts') },
      { find: /^maitre$/, replacement: core('index.ts') },
    ],
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
