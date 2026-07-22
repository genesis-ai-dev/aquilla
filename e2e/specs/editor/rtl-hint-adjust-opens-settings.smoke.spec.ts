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
  await expect(alice.locator('[role="status"]').filter({ hasText: /content looks right-to-left/i })).toHaveCount(0)

  await ws.openViewSettingsMenu()
  const menu = alice.getByRole("menu")
  await menu.getByRole("button", { name: "Target direction LTR" }).click()
  await alice.keyboard.press("Escape")

  const warning = alice.locator('[role="status"]').filter({ hasText: /content looks right-to-left/i })
  await expect(warning).toBeVisible({ timeout: 5_000 })
  await warning.getByRole("button", { name: "Auto", exact: true }).click()

  await expect(warning).not.toBeVisible({ timeout: 3_000 })
  await expect(target).toHaveAttribute("dir", "rtl")
})
