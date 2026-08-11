/**
 * Capture drivers for the surfaces the `dialog` namespace declares (AQU-511).
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

export const dialog: SurfaceDrivers = {
  "assign-modal": async (page: Page) => {
    await page.goto(`${BASE_URL}/project/${DEV_PROJECT}/editor`)
    // AssignModal's trigger lives on the file-options menu, which only
    // renders once a file is open — import a tiny sample if the seed
    // project is empty (same approach as the common "cell-editor" driver).
    const emptyCta = page.getByRole("button", { name: /import a file/i })
    const fileOptionsMenu = page.getByTestId("file-options-menu")
    await emptyCta.or(fileOptionsMenu).first().waitFor({ timeout: 30_000 })
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
      await fileOptionsMenu.waitFor({ timeout: 60_000 })
      const skipDirection = page.getByRole("button", { name: /skip for now/i })
      if (await skipDirection.isVisible().catch(() => false)) {
        await skipDirection.click()
        await skipDirection.waitFor({ state: "hidden", timeout: 10_000 })
      }
    }
    await fileOptionsMenu.click()
    const assignItem = page.getByRole("menuitem", { name: /assign work/i })
    await assignItem.waitFor({ timeout: 10_000 })
    await assignItem.click()
    await page.getByRole("heading", { name: /assign work/i }).waitFor({ timeout: 10_000 })
  },
}
