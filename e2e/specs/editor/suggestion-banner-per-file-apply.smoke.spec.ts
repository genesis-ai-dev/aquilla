import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CHAPTER_1 = path.resolve(__dirname, "../../fixtures/chapter-1.md")
const CHAPTER_2 = path.resolve(__dirname, "../../fixtures/chapter-2.md")

/**
 * FileRow — per-file "Apply rename suggestion" sparkle button.
 *
 * When detectSuggestions identifies a file as part of a numbered family,
 * ExpandableFileList passes `hasSuggestion=true` to FileRow, which renders:
 *
 *   <button aria-label="Apply rename suggestion"
 *     title="A cleaner name was detected for this file. Click to apply, or
 *            use the Apply button at the top of the sidebar.">
 *     <Sparkles />
 *   </button>
 *
 * Clicking it calls handleApplyOneSuggestion(fileId) which renames only
 * that file and shows the "Applied renames." undo toast.
 *
 * This spec: imports chapter-1.md + chapter-2.md → sidebar shows sparkle
 * buttons → clicks the sparkle on the first file → undo toast appears.
 */
test("per-file Apply rename suggestion sparkle renames one file and shows undo toast", async ({ alice }) => {
  // Two sequential FRO-310 import flows (preview → confirm → projection wait)
  // plus project creation routinely exceed the 30s harness budget under load.
  test.slow()
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `PerFileSuggest ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(CHAPTER_1)
  await ws.importFile(CHAPTER_2)

  // Both files should have a sparkle button (aria-label="Apply rename suggestion").
  const sparkles = alice.locator('[aria-label="Apply rename suggestion"]')
  await expect(sparkles.first()).toBeVisible({ timeout: 10_000 })

  // Click the sparkle on the first file.
  await sparkles.first().click()

  // Undo toast appears: "Applied renames."
  const toast = alice.getByText(/Applied renames\./i)
  await expect(toast).toBeVisible({ timeout: 5_000 })

  await expect(alice.getByRole("button", { name: /^Undo$/i })).toBeVisible({ timeout: 3_000 })
})
