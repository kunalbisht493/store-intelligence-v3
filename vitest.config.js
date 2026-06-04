import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals:     true,
    environment: 'node',
    coverage: {
      provider:  'v8',
      reporter:  ['text', 'lcov'],
      threshold: { statements: 70 }
    },
    // Run tests sequentially — they share a live API
    pool:        'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 15000
  }
});
