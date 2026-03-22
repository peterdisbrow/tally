import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**'],
      thresholds: {
        statements: 35,
        branches: 30,
        functions: 30,
        lines: 36,
      },
    },
  },
});
