import { defineConfig } from "@playwright/test"
import base from "./playwright.config.web"

// AQU-2377: exercise the built Vite import/preload graph in each engine.
// E2E_CONFIG=e2e/config/playwright.config.offline-recovery.ts npx tsx scripts/e2e-up.ts
export default defineConfig({
  ...base,
  testMatch: "**/projects/route-health.smoke.spec.ts",
  grep: /first offline editor visit/,
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
})
