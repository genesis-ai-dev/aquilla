import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * ExpandableFileList sidebar file filter.
 *
 * ExpandableFileList.tsx renders a search/filter input above the file list:
 *   - input name="aquilla-file-filter-query" filters files by name
 *   - Non-matching files disappear; empty state: `No files match "<query>".`
 *   - A clear button (aria-label="Clear filter") appears when filter has text
 *
 * This spec:
 *   1. Imports sample.md.
 *   2. Types a query that matches ("samp") → file remains visible.
 *   3. Types a query that doesn't match ("zzz") → no files, empty state shown.
 *   4. Clicks "Clear filter" → file reappears.
 */
test("sidebar file filter narrows file list and clear restores it", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `FileFilter ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)

  const sidebar = alice.locator("aside")

  // File "sample" should be visible in the sidebar initially.
  await expect(sidebar.getByText("sample").first()).toBeVisible({ timeout: 10_000 })

  // Type a matching filter.
  const filterInput = sidebar.locator('input[name="aquilla-file-filter-query"]')
  await expect(filterInput).toBeVisible({ timeout: 5_000 })
  await filterInput.fill("samp")

  // File still visible (matches "sample").
  await expect(sidebar.getByText("sample").first()).toBeVisible({ timeout: 3_000 })

  // Type a non-matching filter — file should disappear.
  await filterInput.fill("zzz")

  // Empty state message appears.
  await expect(sidebar.getByText(/No files match/i).first()).toBeVisible({ timeout: 3_000 })

  // "Clear filter" button appears and clicking it restores the list.
  const clearBtn = sidebar.locator('button[aria-label="Clear filter"]')
  await expect(clearBtn).toBeVisible({ timeout: 2_000 })
  await clearBtn.click()

  // Filter cleared — file is visible again.
  await expect(sidebar.getByText("sample").first()).toBeVisible({ timeout: 3_000 })
  // Empty state gone.
  await expect(sidebar.getByText(/No files match/i)).not.toBeVisible({ timeout: 2_000 })
})
