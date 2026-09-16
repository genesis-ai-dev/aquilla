import path from "node:path"
import { defineConfig } from "vitest/config"

// Separate gate: requires local Postgres and creates its own disposable database.
export default defineConfig({
  resolve: { alias: {
    "cloudflare:test": path.resolve(__dirname,
      "src/__tests__/helpers/pg-test-env.ts"),
  } },
  test: {
    environment: "node",
    include: ["src/__tests__/billing-chat-usage.test.ts","src/__tests__/billing-import-usage.test.ts","src/__tests__/billing-agent-usage.test.ts","src/__tests__/billing-usage-reconcile.test.ts","src/__tests__/billing-workspace-usage.test.ts","src/__tests__/billing-native-lifecycle.test.ts","src/__tests__/billing-native-catalog.test.ts","src/__tests__/billing-workspace-portal.test.ts","src/__tests__/billing-workspace-checkout.test.ts",
      "src/__tests__/billing-workspace-change.test.ts",
      "src/__tests__/billing-webhook-recovery.test.ts",
      "src/__tests__/billing-webhook-concurrency.postgres.ts"],
    setupFiles: ["src/__tests__/helpers/webhook-postgres-setup.ts"],
    maxWorkers: 1,
    testTimeout: 60000,
    hookTimeout: 60000,
  },
})
