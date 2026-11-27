import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,js}"],
    // Builds the schema'd database once per run; every makeTestDb() is a copy
    // of it (db/shared/test-pg-harness.ts).
    globalSetup: ["./src/__tests__/helpers/pg-template-global-setup.ts"],
    // Tests run against real Postgres in-process (PGlite WASM). Each database
    // is CPU-heavy to start even as a copy, so cap parallelism to avoid
    // contention and give generous timeouts.
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: "forks",
    minWorkers: 1,
    maxWorkers: 3,
  },
})
