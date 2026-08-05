import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * ViewSettingsMenu — "Show cell labels" switch.
 *
 * Clicking the switch fires onCellLabelsChange; the popover stays open.
 * Closing and reopening still reflects the new state.
 */
test("view settings Show cell labels toggle persists state across open/close", async ({
  alice,
}) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `CellLabels ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  await ws.openViewSettingsMenu()

  const panel = alice.getByTestId("view-settings-popover")
  const cellLabels = panel.getByRole("switch", { name: /Show cell labels/i })
  await expect(cellLabels).toBeVisible({ timeout: 3_000 })

  const initialChecked = await cellLabels.isChecked()
  await cellLabels.click()
  await expect(cellLabels).toHaveAttribute("aria-checked", initialChecked ? "false" : "true")

  await alice.keyboard.press("Escape")
  await expect(panel).not.toBeVisible({ timeout: 3_000 })

  await ws.openViewSettingsMenu()
  await expect(cellLabels).toBeVisible({ timeout: 3_000 })
  await expect(cellLabels).toHaveAttribute("aria-checked", initialChecked ? "false" : "true")

  await cellLabels.click()
  await alice.keyboard.press("Escape")
  await ws.openViewSettingsMenu()
  await expect(cellLabels).toBeVisible({ timeout: 3_000 })
  await expect(cellLabels).toHaveAttribute("aria-checked", initialChecked ? "true" : "false")
})
