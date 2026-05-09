/**
 * Playwright config for running the local-store + editor-v2 smoke specs
 * against the *deployed Cloudflare Pages preview*. Validates that the
 * production build's response headers, asset paths, and SQLite-WASM
 * loading all work end-to-end on Pages — not just localhost.
 *
 * Usage:
 *   PREVIEW_URL=https://refactor-data-persistence.codex-web-4ih.pages.dev \
 *     npx playwright test --config=e2e/config/playwright.config.preview.ts
 *
 * No webServer — we're hitting a live deploy.
 */

import { defineConfig, devices } from "@playwright/test"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "../..")

const PREVIEW_URL =
  process.env.PREVIEW_URL ??
  "https://refactor-data-persistence.codex-web-4ih.pages.dev"

export default defineConfig({
  testDir: path.resolve(REPO_ROOT, "e2e/specs/local-store"),
  // Each test cleans up its own OPFS state, but they target a shared
  // origin — keep serial.
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  // Pages cold-start can take a few seconds; give a bit more headroom.
  timeout: 30_000,
  use: {
    baseURL: PREVIEW_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // We're hitting a live origin; bypass any aggressive HTTP caching from
    // earlier deploys.
    extraHTTPHeaders: {
      "Cache-Control": "no-cache",
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
})
