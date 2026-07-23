import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ImportDialog — eBible Corpus search input filters results.
 *
 * The eBible screen (ImportDialog.tsx, screen="ebible") shows:
 *   - A search Input placeholder="Search by language, title, or id (e.g. 'eng', 'KJV')"
 *   - A list of translation entries filtered by the query
 *
 * Typing in the search input filters the list. Typing a common language
 * like "English" should return results. Typing a gibberish string should
 * show an empty state.
 *
 * This spec: open eBible screen → verify search input is visible →
 * type "English" → at least one result appears → clear to "xxxnotacode" →
 * results collapse to empty.
 */
test("eBible corpus search input filters translation list", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `EBibleSearch ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)
  // Open ImportDialog.
  const importBtn = alice.getByRole("button", { name: /^Import$/i }).first()
  await expect(importBtn).toBeVisible({ timeout: 10_000 })
  await importBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // Navigate to eBible screen.
  await dialog.getByText("eBible Corpus").click()
  await expect(dialog.getByRole("heading", { name: /eBible Corpus/i })).toBeVisible({ timeout: 3_000 })

  // Search input is visible. (Placeholder is "Search by language, title, or
  // id (e.g. 'eng', 'KJV')" — EBiblePanel's shared translation picker.)
  const searchInput = dialog.locator('input[placeholder*="Search by language"]')
  await expect(searchInput).toBeVisible({ timeout: 5_000 })

  // Type "English" — expect results to appear. The input stays disabled until
  // the translations list (network fetch) loads, and fill() waits for enabled.
  await expect(searchInput).toBeEnabled({ timeout: 15_000 })
  await searchInput.fill("English")
  // At least one result (button or list item) appears within 3s.
  await expect(dialog.locator('button').filter({ hasText: /English/i }).first()).toBeVisible({ timeout: 5_000 })

  // Clear and type gibberish — list collapses.
  await searchInput.fill("xxxnotavalidcode999zzz")
  // Verify no "English" results remain.
  await expect(dialog.locator('button').filter({ hasText: /English/i }).first()).not.toBeVisible({ timeout: 3_000 })

  // Back to landing.
  await dialog.getByRole("button", { name: /Back/i }).click()
  await alice.keyboard.press("Escape")
})
