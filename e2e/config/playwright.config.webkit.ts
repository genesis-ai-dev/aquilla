import { defineConfig, devices } from "@playwright/test"
import base from "./playwright.config.web"

// Opt-in Safari-engine diagnostics using the same isolated backend and seeds:
// E2E_CONFIG=e2e/config/playwright.config.webkit.ts pnpm exec tsx scripts/e2e-up.ts -- <spec>
// Install once with: pnpm exec playwright install webkit
export default defineConfig({
  ...base,
  projects: [{ name: "webkit", use: { ...devices["Desktop Safari"] } }],
})
