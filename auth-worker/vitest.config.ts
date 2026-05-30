import path from "node:path"
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"))
  return {
    plugins: [
      cloudflareTest({
        wrangler: {
          configPath: "./wrangler.toml",
        },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            SECRET_KEY: "frontier-test-secret",
            SYNC_SECRET_KEY: "sync-secret",
          },
        },
      }),
    ],
    test: {
      include: ["src/**/*.test.ts"],
      setupFiles: ["./src/__tests__/setup-migrations.ts"],
    },
  }
})
