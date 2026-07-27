import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Tests run against real Postgres in-process (PGlite WASM). Init is ~1s and
    // CPU-heavy, so cap parallelism to avoid contention and give generous timeouts.
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: "forks",
    minWorkers: 1,
    maxWorkers: 3,
  },
})
