import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * ViewSettingsMenu — text direction modes.
 *
 * The menu (opened via header ⋯ → "View settings", FRO-331) exposes explicit
 * Auto / LTR / RTL controls for the source and target columns.
 */
test("view settings text direction Source mode can force RTL and return to Auto", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `TextDir ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  // Open the view settings menu from the header overflow menu (FRO-331).
  await ws.openViewSettingsMenu()

  const menu = alice.getByRole("menu")
  await expect(menu.getByText("Text Direction")).toBeVisible({ timeout: 3_000 })

  const sourceText = alice.locator('[data-cell-type="source"]').first()
  await expect(sourceText).toHaveAttribute("dir", "ltr")

  const sourceAuto = menu.getByRole("button", { name: "Source direction Auto" })
  const sourceRtl = menu.getByRole("button", { name: "Source direction RTL" })
  await expect(sourceAuto).toHaveAttribute("aria-pressed", "true")

  await sourceRtl.click()
  await expect(sourceRtl).toHaveAttribute("aria-pressed", "true")
  await expect(sourceText).toHaveAttribute("dir", "rtl")

  await sourceAuto.click()
  await expect(sourceAuto).toHaveAttribute("aria-pressed", "true")
  await expect(sourceText).toHaveAttribute("dir", "ltr")

  // Close menu.
  await alice.keyboard.press("Escape")
})
