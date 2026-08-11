/**
 * Capture drivers for the surfaces the `search` namespace declares (AQU-511).
 *
 * Each driver navigates to the state its surface describes, settles on an
 * observable element, and leaves the page ready for a screenshot. Driven by
 * `scripts/i18n-shots.ts`; `src/lib/i18n/context.test.ts` asserts every declared
 * surface has one here.
 */

import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Page } from "@playwright/test"
import { BASE_URL, DEV_PROJECT, type SurfaceDrivers } from "./shared"

export const search: SurfaceDrivers = {
  search: async (page: Page) => {
    await page.goto(`${BASE_URL}/project/${DEV_PROJECT}/editor`)

    // The seed project ships empty; import a tiny sample so there is
    // something for the search dock to find, mirroring the `common` driver's
    // cell-editor setup.
    const emptyCta = page.getByRole("button", { name: /import a file/i })
    const cell = page.getByText("In the beginning God created", { exact: false }).first()
    await emptyCta.or(cell).first().waitFor({ timeout: 30_000 })
    if (await emptyCta.isVisible().catch(() => false)) {
      const samplePath = join(tmpdir(), "i18n-shots-sample.txt")
      writeFileSync(
        samplePath,
        "In the beginning God created the heavens and the earth.\n" +
          "And God said, Let there be light: and there was light.\n",
      )
      await emptyCta.click()
      await page.getByRole("dialog").waitFor({ timeout: 10_000 })
      await page.getByText("Upload files", { exact: true }).click()
      const fileInput = page.locator('input[type="file"]').first()
      await fileInput.waitFor({ state: "attached", timeout: 10_000 })
      await fileInput.setInputFiles(samplePath)
      await page.getByRole("button", { name: /confirm import/i }).click()
      await cell.waitFor({ timeout: 60_000 })
      const skipDirection = page.getByRole("button", { name: /skip for now/i })
      if (await skipDirection.isVisible().catch(() => false)) {
        await skipDirection.click()
        await skipDirection.waitFor({ state: "hidden", timeout: 10_000 })
      }
    }

    // Open the search dock (left dock rail icon, aria-label "Search").
    await page.getByRole("button", { name: "Search", exact: true }).first().click()

    // Enter a query that matches the sample text so the shot shows results.
    const searchBox = page.getByPlaceholder(/search/i).first()
    await searchBox.waitFor({ timeout: 15_000 })
    await searchBox.fill("God")
    await page.getByText("God created", { exact: false }).first().waitFor({ timeout: 15_000 })
  },
}
