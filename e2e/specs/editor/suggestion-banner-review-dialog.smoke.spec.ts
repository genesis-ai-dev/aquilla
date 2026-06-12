import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CHAPTER_1 = path.resolve(__dirname, "../../fixtures/chapter-1.md")
const CHAPTER_2 = path.resolve(__dirname, "../../fixtures/chapter-2.md")

/**
 * SuggestionBanner — "Review" button opens RenameSuggestionsDialog.
 *
 * When numbered files are detected, SuggestionBanner shows:
 *   - "Review" button → opens Dialog with title "Review suggested names"
 *   - Each suggestion row has a checkbox (pre-checked) showing:
 *       <currentName strikethrough> → <suggestedName>
 *   - "Cancel" closes without applying
 *   - "Apply N changes" applies the checked suggestions
 *
 * This spec: imports chapter-1.md + chapter-2.md → banner appears →
 * clicks "Review" → dialog opens with title "Review suggested names" and
 * both suggestion rows visible → clicks "Cancel" → dialog closes.
 */
test("suggestion banner Review opens dialog with file suggestions; Cancel closes it", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `SuggestReview ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(CHAPTER_1)
  await ws.importFile(CHAPTER_2)

  // Wait for SuggestionBanner to appear.
  const banner = alice.getByText(/apply friendly names/i)
  await expect(banner).toBeVisible({ timeout: 10_000 })

  // Click "Review".
  const reviewBtn = alice.getByRole("button", { name: /^Review$/i })
  await expect(reviewBtn).toBeVisible({ timeout: 3_000 })
  await reviewBtn.click()

  // Dialog opens with title "Review suggested names".
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog.getByText(/Review suggested names/i)).toBeVisible()

  // Both file suggestions are listed with checkboxes (pre-checked).
  // shadcn Checkbox — role="checkbox" spans (native inputs are hidden).
  const checkboxes = dialog.getByRole("checkbox")
  await expect(checkboxes).toHaveCount(2, { timeout: 3_000 })

  // "Apply N changes" button is enabled (2 suggestions pre-checked).
  const applyBtn = dialog.getByRole("button", { name: /Apply \d+ change/i })
  await expect(applyBtn).toBeEnabled({ timeout: 3_000 })

  // Cancel closes the dialog.
  await dialog.getByRole("button", { name: /^Cancel$/i }).click()
  await expect(dialog).not.toBeVisible({ timeout: 3_000 })
})
