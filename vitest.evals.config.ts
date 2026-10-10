import { defineConfig } from 'vitest/config';

// The evaluation calls real models and costs money: it never runs with `npm test`.
export default defineConfig({
  test: {
    include: ['evals/**/*.eval.ts'],
    testTimeout: 3_600_000,
  },
});
