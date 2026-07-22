import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * ViewSettingsMenu — "Show cell labels" pill toggle.
 *
 * ViewSettingsMenu.tsx renders a "Show cell labels" Menu.Item with a Pill
 * that shows "On" or "Off". Clicking the item fires onCellLabelsChange and
 * the Radix Menu dismisses. On reopening the menu the pill reflects the new
 * state.
 *
 * This spec: open view settings menu → note the initial "Show cell labels"
 * pill text → click the item (dismisses menu) → reopen → verify pill text
 * has flipped → click again → reopen → verify back to original.
 */
test("view settings Show cell labels toggle persists state across open/close", async ({
  alice,
}) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `CellLabels ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  // Open menu and capture initial state of the "Show cell labels" pill.
  await ws.openViewSettingsMenu()

  const cellLabelsText = alice.getByText(/Show cell labels/i).first()
  await expect(cellLabelsText).toBeVisible({ timeout: 3_000 })

  // The On/Off pill must be read from the "Show cell labels" MENU ITEM —
  // "Show line numbers" renders first in the menu with its own pill, so an
  // unscoped `span:has-text(On|Off)` first() reads the wrong toggle.
  const cellLabelsItem = alice.getByRole("menuitem", { name: /Show cell labels/i })
  const cellLabelsPill = cellLabelsItem.locator("span").filter({ hasText: /^(On|Off)$/ })
  const initialPill = await cellLabelsPill.textContent()

  // Click the item to toggle (dismisses menu).
  await cellLabelsText.click()
  await expect(cellLabelsText).not.toBeVisible({ timeout: 3_000 })

  // Reopen and verify the pill flipped.
  await ws.openViewSettingsMenu()
  await expect(cellLabelsText).toBeVisible({ timeout: 3_000 })

  const toggledPill = await cellLabelsPill.textContent()
  expect(toggledPill).not.toEqual(initialPill)

  // Toggle back.
  await cellLabelsText.click()
  await ws.openViewSettingsMenu()
  await expect(cellLabelsText).toBeVisible({ timeout: 3_000 })

  const revertedPill = await cellLabelsPill.textContent()
  expect(revertedPill).toEqual(initialPill)
})
