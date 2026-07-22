import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Living Memory — add an Instructions entry.
 *
 * Each section (Instructions, Standards) has a "+ Add" button that opens an
 * inline EntryForm with a textarea. Typing text and clicking Save persists
 * the entry to IDB and renders it in the section.
 * Cancel closes the form without adding.
 *
 * This spec tests the add-entry flow on the Instructions section.
 */
test("living memory add entry form appears and Cancel closes it", async ({ alice }) => {
  const name = `MemAdd ${Date.now()}`
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name })

  await alice.goto(`/project/${seeded.projectId}/memory`)
  await alice.waitForLoadState("networkidle")

  // The Instructions section has an "Add" button.
  const instructionsSection = alice.locator('section[aria-label="Instructions"]')
  await expect(instructionsSection).toBeVisible({ timeout: 10_000 })

  const addBtn = instructionsSection.getByRole("button", { name: /Add/i })
  await expect(addBtn).toBeVisible({ timeout: 5_000 })
  await addBtn.click()

  // Inline EntryForm appears with a textarea.
  const textarea = instructionsSection.locator("textarea").first()
  await expect(textarea).toBeVisible({ timeout: 3_000 })

  // Type an entry.
  const entryText = "Always translate 'Lord' as 'Seigneur'."
  await textarea.fill(entryText)

  // Verify Save and Cancel buttons are present.
  await expect(instructionsSection.getByRole("button", { name: /Save/i })).toBeVisible()
  await expect(instructionsSection.getByRole("button", { name: /Cancel/i })).toBeVisible()

  // Cancel closes the form without saving.
  await instructionsSection.getByRole("button", { name: /Cancel/i }).click()
  await expect(textarea).not.toBeVisible({ timeout: 3_000 })

  // Add button is visible again (form closed).
  await expect(addBtn).toBeVisible({ timeout: 3_000 })
})

test("living memory add entry saves and appears in section", async ({ alice }) => {
  const name = `MemSave ${Date.now()}`
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name })

  await alice.goto(`/project/${seeded.projectId}/memory`)
  await alice.waitForLoadState("networkidle")

  const instructionsSection = alice.locator('section[aria-label="Instructions"]')
  const addBtn = instructionsSection.getByRole("button", { name: /Add/i })
  await addBtn.click()

  const textarea = instructionsSection.locator("textarea").first()
  await expect(textarea).toBeVisible({ timeout: 3_000 })

  const entryText = `Test instruction ${Date.now()}`
  await textarea.fill(entryText)
  await instructionsSection.getByRole("button", { name: /Save/i }).click()

  // Entry appears in the section after save.
  await expect(instructionsSection.getByText(entryText)).toBeVisible({ timeout: 5_000 })
})
