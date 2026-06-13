import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CHAPTER_1 = path.resolve(__dirname, "../../fixtures/chapter-1.md")
const CHAPTER_2 = path.resolve(__dirname, "../../fixtures/chapter-2.md")

/**
 * SuggestionBanner — "Apply all" and undo toast.
 *
 * When two files share a common numbered stem (e.g. chapter-1.md,
 * chapter-2.md), detectNumberedFamily surfaces them as rename suggestions.
 * SuggestionBanner renders with an "Apply all" button.
 *
 * Clicking "Apply all" calls handleApplySuggestions which:
 *   1. Renames the files (applyRenames).
 *   2. Shows an undo toast: "Applied renames." + "Undo" button.
 *   3. The banner disappears (detectSuggestions no longer matches).
 *
 * Clicking "Undo" in the toast reverts the renames and clears the toast.
 *
 * This spec:
 *   1. Imports chapter-1.md + chapter-2.md.
 *   2. Clicks "Apply all" on the SuggestionBanner.
 *   3. Verifies the "Applied renames." toast appears with "Undo" button.
 *   4. Verifies the banner is gone.
 *   5. Clicks "Undo" — toast disappears.
 */
test("suggestion banner Apply all shows undo toast; clicking Undo clears it", async ({ alice }) => {
  // Two sequential FRO-310 import flows (preview → confirm → projection wait)
  // plus project creation routinely exceed the 30s harness budget under load.
  test.slow()
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `SuggestApply ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(CHAPTER_1)
  await ws.importFile(CHAPTER_2)

  // Wait for SuggestionBanner to appear.
  const banner = alice.getByText(/apply friendly names/i)
  await expect(banner).toBeVisible({ timeout: 10_000 })

  // Click "Apply all".
  const applyAllBtn = alice.getByRole("button", { name: /Apply all/i })
  await expect(applyAllBtn).toBeVisible({ timeout: 3_000 })
  await applyAllBtn.click()

  // Undo toast appears: "Applied renames." with an "Undo" button.
  const toast = alice.getByText(/Applied renames\./i)
  await expect(toast).toBeVisible({ timeout: 5_000 })
  const undoBtn = alice.getByRole("button", { name: /^Undo$/i })
  await expect(undoBtn).toBeVisible({ timeout: 3_000 })

  // Banner should be gone (files now have new names, no longer match suggestions).
  await expect(banner).not.toBeVisible({ timeout: 3_000 })

  // Click Undo — renames are reverted, toast disappears.
  await undoBtn.click()
  await expect(toast).not.toBeVisible({ timeout: 5_000 })
})
