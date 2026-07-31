import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Living Memory — delete an entry via the confirmation dialog.
 *
 * After saving an entry, hovering it reveals "Delete entry" (aria-label).
 * Clicking opens a Dialog with DialogTitle "Delete entry?".
 * Cancel keeps the entry; Confirm removes it.
 *
 * This spec adds an entry, opens the delete dialog, and confirms deletion.
 */
test("living memory delete entry dialog confirms and removes the entry", async ({ alice }) => {
  const name = `MemDel ${Date.now()}`
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name })

  await alice.goto(`/project/${seeded.projectId}/memory`)
  // Add an entry first via create dialog.
  const instructionsSection = alice.locator('section[aria-label="Instructions"]')
  await instructionsSection.getByRole("button", { name: /Add/i }).click()
  const addDialog = alice.getByRole("dialog")
  await expect(addDialog).toBeVisible({ timeout: 3_000 })
  const textarea = addDialog.locator("textarea").first()
  await expect(textarea).toBeVisible({ timeout: 3_000 })
  const entryText = `Delete-me ${Date.now()}`
  await textarea.fill(entryText)
  await addDialog.getByRole("button", { name: /Save/i }).click()
  await expect(addDialog).not.toBeVisible({ timeout: 5_000 })

  // Entry renders in the section.
  const entryCard = instructionsSection.getByText(entryText).first()
  await expect(entryCard).toBeVisible({ timeout: 5_000 })

  // Hover the card to reveal delete button.
  await entryCard.hover()
  const deleteBtn = instructionsSection.getByRole("button", { name: /Delete entry/i }).first()
  await expect(deleteBtn).toBeVisible({ timeout: 3_000 })
  await deleteBtn.click()

  // Confirmation dialog.
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog.getByRole("heading", { name: /Delete entry/i })).toBeVisible()

  // Confirm deletion.
  await dialog.getByRole("button", { name: /Delete/i }).click()
  await expect(dialog).not.toBeVisible({ timeout: 3_000 })

  // Entry is gone from the section.
  await expect(instructionsSection.getByText(entryText)).not.toBeVisible({ timeout: 5_000 })
})
