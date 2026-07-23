import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * LivingMemoryPage — edit an existing entry.
 *
 * Each entry row has an "Edit entry" button (aria-label="Edit entry").
 * Clicking it replaces the entry text with an EntryForm pre-filled with
 * the current text. Saving updates the entry in place.
 *
 * This spec: adds an entry → clicks Edit entry → changes the text →
 * clicks Save → verifies the updated text appears.
 */
test("living memory edit entry updates the text in place", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `MemEdit ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/memory`)
  const instructionsSection = alice.locator('section[aria-label="Instructions"]')
  await expect(instructionsSection).toBeVisible({ timeout: 10_000 })

  // Add an initial entry.
  const addBtn = instructionsSection.getByRole("button", { name: /Add/i })
  await addBtn.click()
  const textarea = instructionsSection.locator("textarea").first()
  await expect(textarea).toBeVisible({ timeout: 3_000 })
  const original = `Original text ${Date.now()}`
  await textarea.fill(original)
  await instructionsSection.getByRole("button", { name: /^Save$/i }).click()
  await expect(instructionsSection.getByText(original)).toBeVisible({ timeout: 5_000 })

  // Entries render as Cards (divs), not <li> rows. With a single entry in the
  // section, scope the Edit button to the section itself.
  await instructionsSection.getByText(original).hover()

  // Click "Edit entry" (aria-label, always rendered for editors).
  const editBtn = instructionsSection.getByRole("button", { name: /Edit entry/i })
  await expect(editBtn).toBeVisible({ timeout: 3_000 })
  await editBtn.click()

  // EntryForm appears pre-filled with the original text.
  const editTextarea = instructionsSection.locator("textarea").first()
  await expect(editTextarea).toBeVisible({ timeout: 3_000 })
  await expect(editTextarea).toHaveValue(original)

  // Change the text and save.
  const updated = `Updated text ${Date.now()}`
  await editTextarea.fill(updated)
  await instructionsSection.getByRole("button", { name: /^Save$/i }).click()

  // Updated text is now visible; original is gone.
  await expect(instructionsSection.getByText(updated)).toBeVisible({ timeout: 5_000 })
  await expect(instructionsSection.getByText(original)).not.toBeVisible({ timeout: 3_000 })
})
