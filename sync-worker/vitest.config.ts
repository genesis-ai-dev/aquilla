import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  // Shared SPA modules (../src) import each other through `@/`, the alias the
  // SPA and tsconfig.json both define; wrangler's esbuild reads it from
  // tsconfig.json. The Drive folder sync bundles the import normalizer.
  resolve: { alias: { "@/": fileURLToPath(new URL("../src/", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,js}"],
    // Tests run against real Postgres in-process (PGlite WASM). Init is ~1s and
    // CPU-heavy, so cap parallelism to avoid contention and give generous timeouts.
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: "forks",
    minWorkers: 1,
    maxWorkers: 3,
  },
})
