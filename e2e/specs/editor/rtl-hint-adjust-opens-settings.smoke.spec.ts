import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/** Auto direction is silent; a conflicting manual override offers an immediate
 * Auto repair that restores content-driven direction. */
test("direction mismatch Auto action restores content-driven target direction", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `RtlAdjust ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  await ws.editCell(0, "مرحبا بالعالم")

  // Auto already renders the committed Arabic target RTL without a banner.
  const target = alice.locator('[data-cell-type="target"] [data-target-read-view]').first()
  await expect(target).toHaveAttribute("dir", "rtl")
  await expect(alice.getByRole("dialog").filter({ hasText: /content looks right-to-left/i })).toHaveCount(0)

  await ws.openViewSettingsMenu()
  const panel = alice.getByTestId("view-settings-popover")
  await panel.getByRole("tablist", { name: "Target direction" }).getByRole("tab", { name: "LTR" }).click()

  const warning = alice.getByRole("dialog").filter({ hasText: /content looks right-to-left/i })
  await expect(warning).toBeVisible({ timeout: 5_000 })
  await warning.getByRole("button", { name: "Auto", exact: true }).click()

  await expect(warning).not.toBeVisible({ timeout: 3_000 })
  await expect(target).toHaveAttribute("dir", "rtl")
})
