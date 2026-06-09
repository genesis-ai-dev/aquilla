import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CHAPTER_1 = path.resolve(__dirname, "../../fixtures/chapter-1.md")
const CHAPTER_2 = path.resolve(__dirname, "../../fixtures/chapter-2.md")

/**
 * SuggestionBanner — rename detection and Dismiss button.
 *
 * ProjectWorkspace.tsx calls detectSuggestions(project) via useMemo whenever
 * project.files changes. detectSuggestions runs detectNumberedFamily which
 * groups files by their shared stem. When two files share a common stem
 * (e.g. "chapter-1.md" and "chapter-2.md" both have stem "chapter"),
 * they form a "numbered family" and appear as rename suggestions.
 *
 * SuggestionBanner.tsx renders above the sidebar file list when
 * bannerSuggestions.length > 0 and the user hasn't dismissed yet:
 *   - "N numbered files — apply friendly names?" label
 *   - "Review" button → opens RenameSuggestionsDialog
 *   - "Apply all" button → applies all suggestions immediately
 *   - "Dismiss" button (aria-label="Dismiss") → hides the banner
 *
 * This spec: imports chapter-1.md + chapter-2.md → banner appears →
 * clicks "Dismiss" → banner disappears.
 */
test("suggestion banner appears for numbered files and can be dismissed", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `SuggestBanner ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  // Import two files with the same stem (chapter-N) to trigger numbered-family detection.
  await ws.importFile(CHAPTER_1)
  await ws.importFile(CHAPTER_2)

  // The SuggestionBanner should appear after both files are imported.
  // It shows the count of numbered files and the "apply friendly names?" prompt.
  const banner = alice.getByText(/numbered files? — apply friendly names\?/i)
    .or(alice.getByText(/apply friendly names/i))
  await expect(banner).toBeVisible({ timeout: 10_000 })

  // The Dismiss button is visible (aria-label="Dismiss").
  const dismissBtn = alice.locator('[aria-label="Dismiss"]')
  await expect(dismissBtn).toBeVisible({ timeout: 3_000 })

  // Click Dismiss — banner should disappear.
  await dismissBtn.click()
  await expect(banner).not.toBeVisible({ timeout: 3_000 })
})
