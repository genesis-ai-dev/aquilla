/**
 * Probe-only spec used to debug the deployed preview when /dev/local-store
 * hangs at the loading state. Logs console + page errors and returns the
 * first useful diagnostic.
 *
 * Run with the preview config:
 *   PREVIEW_URL=https://refactor-data-persistence.codex-web-4ih.pages.dev \
 *     npx playwright test --config=e2e/config/playwright.config.preview.ts \
 *     -g "preview probe"
 */

import { test } from "@playwright/test"

test("preview probe — capture console output on /dev/local-store", async ({
  page,
}) => {
  const events: string[] = []
  page.on("console", (msg) => {
    events.push(`[${msg.type()}] ${msg.text()}`)
  })
  page.on("pageerror", (err) => {
    events.push(`[pageerror] ${err.message}`)
  })
  page.on("requestfailed", (req) => {
    events.push(`[requestfailed] ${req.url()} — ${req.failure()?.errorText}`)
  })

  await page.goto("/dev/local-store")
  // Wait the same window the real spec would.
  await page.waitForTimeout(8_000)

  const isolated = await page.evaluate(() =>
    typeof window.crossOriginIsolated === "boolean"
      ? window.crossOriginIsolated
      : null,
  )
  const opfsAvailable = await page.evaluate(
    async () => typeof navigator.storage?.getDirectory === "function",
  )

  // eslint-disable-next-line no-console
  console.log(
    "\n========== preview probe ==========\n" +
      `crossOriginIsolated: ${isolated}\n` +
      `OPFS available     : ${opfsAvailable}\n` +
      "console events:\n" +
      events.map((l) => "  " + l).join("\n") +
      "\n===================================\n",
  )
})
