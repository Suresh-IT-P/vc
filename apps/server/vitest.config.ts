import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The integration suites share one SQLite/MySQL database, so they must not
    // interleave. A single fork keeps ordering deterministic.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
    globalSetup: ['./tests/global-setup.ts'],
  },
});
