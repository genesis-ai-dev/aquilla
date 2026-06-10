import path from "node:path"
import { defineConfig } from "vitest/config"

// auth-worker tests run against real Postgres (PGlite) through the production
// D1→Postgres shim, NOT miniflare's SQLite D1. "cloudflare:test" is aliased to
// a PGlite-backed shim (src/__tests__/helpers/pg-test-env.ts) so the existing
// `import { env } from "cloudflare:test"` test imports keep working unchanged.
export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:test": path.resolve(__dirname, "./src/__tests__/helpers/pg-test-env.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/__tests__/setup-migrations.ts"],
    testTimeout: 60000,
    hookTimeout: 60000,
    forks: { minForks: 1, maxForks: 3 },
  },
})
