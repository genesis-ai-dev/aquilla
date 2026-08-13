import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/** A manual direction that conflicts with committed text can be dismissed
 * without changing the user's explicit direction choice. */
test("manual target direction mismatch warning can be dismissed", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `RtlHint ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  await ws.editCell(0, "مرحبا بالعالم")
  await ws.openViewSettingsMenu()
  const panel = alice.getByTestId("view-settings-popover")
  await panel.getByRole("tablist", { name: "Target direction" }).getByRole("tab", { name: "LTR" }).click()

  const warning = alice.getByRole("dialog").filter({ hasText: /content looks right-to-left/i })
  await expect(warning).toContainText(/Target is forced left-to-right/i, { timeout: 5_000 })
  await warning.locator('[data-slot="toast-close"]').click()
  await expect(warning).not.toBeVisible({ timeout: 3_000 })

  // Dismissal does not silently change the user's manual override.
  await alice.keyboard.press("Escape")
  await ws.openViewSettingsMenu()
  await expect(panel.getByRole("tablist", { name: "Target direction" }).getByRole("tab", { name: "LTR" }))
    .toHaveAttribute("aria-selected", "true")
})
