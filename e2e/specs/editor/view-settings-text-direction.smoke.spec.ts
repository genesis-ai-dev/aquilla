import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * ViewSettingsMenu — text direction modes.
 *
 * The popover (opened via File options ⋯ → "Editor settings", FRO-331) exposes explicit
 * Auto / LTR / RTL tabs for the source and target columns.
 */
test("view settings text direction Source mode can force RTL and return to Auto", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `TextDir ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  await ws.openViewSettingsMenu()

  const panel = alice.getByTestId("view-settings-popover")
  await expect(panel.getByText("Text Direction")).toBeVisible({ timeout: 3_000 })

  const sourceText = alice.locator('[data-cell-type="source"]').first()
  await expect(sourceText).toHaveAttribute("dir", "ltr")

  const sourceTabs = panel.getByRole("tablist", { name: "Source direction" })
  const sourceAuto = sourceTabs.getByRole("tab", { name: "Auto" })
  const sourceRtl = sourceTabs.getByRole("tab", { name: "RTL" })
  await expect(sourceAuto).toHaveAttribute("aria-selected", "true")

  await sourceRtl.click()
  await expect(sourceRtl).toHaveAttribute("aria-selected", "true")
  await expect(sourceText).toHaveAttribute("dir", "rtl")

  await sourceAuto.click()
  await expect(sourceAuto).toHaveAttribute("aria-selected", "true")
  await expect(sourceText).toHaveAttribute("dir", "ltr")

  await alice.keyboard.press("Escape")
})
