import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**'],
      // Thresholds ratcheted from P2 baselines after P3-P9 test additions.
      // Raise each value quarterly as coverage improves — never lower them.
      thresholds: {
        statements: 42,
        branches: 38,
        functions: 37,
        lines: 43,
      },
    },
  },
});
