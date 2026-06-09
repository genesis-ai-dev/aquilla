import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * ExpandableFileList — expand a file row to reveal FileSectionGrid.
 *
 * FileRow.tsx has an expand toggle button (aria-label="Expand" / "Collapse").
 * When expanded, FileSectionGrid renders sub-rows for each section derived
 * from the cell data. sample.md has two sections:
 *   - "Section One" (from "## Section One")
 *   - "Section Two" (from "## Section Two")
 *
 * This spec:
 *   1. Imports sample.md.
 *   2. Waits for the file to appear in the sidebar.
 *   3. Clicks the "Expand" button on the file row.
 *   4. Verifies the section rows (Section One, Section Two) become visible.
 *   5. Clicks "Section Two" — verifies no error (scroll request fires).
 *   6. Clicks "Collapse" — section rows disappear.
 */
test("expanding a file row reveals section rows in the sidebar", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `FileSections ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)

  // Wait for the file to appear in the sidebar.
  const sidebar = alice.locator("aside")
  await expect(
    sidebar.locator("div").filter({ hasText: /sample/i }).first()
  ).toBeVisible({ timeout: 10_000 })

  // Click the "Expand" button on the file row (chevron icon).
  const expandBtn = sidebar.locator('[aria-label="Expand"]').first()
  await expect(expandBtn).toBeVisible({ timeout: 5_000 })
  await expandBtn.click()

  // FileSectionGrid loads sections. sample.md has ## Section One and ## Section Two.
  // Allow up to 10s for section progress to load from the sync-worker.
  await expect(
    sidebar.getByText(/Section One/i).first()
  ).toBeVisible({ timeout: 10_000 })
  await expect(
    sidebar.getByText(/Section Two/i).first()
  ).toBeVisible({ timeout: 3_000 })

  // Click "Section Two" — requestScrollToSection fires (no error expected).
  await sidebar.getByText(/Section Two/i).first().click()
  // Editor should still be visible (no crash).
  await ws.waitForEditor()

  // Collapse the file row — sections disappear.
  const collapseBtn = sidebar.locator('[aria-label="Collapse"]').first()
  await expect(collapseBtn).toBeVisible({ timeout: 3_000 })
  await collapseBtn.click()
  await expect(
    sidebar.getByText(/Section One/i).first()
  ).not.toBeVisible({ timeout: 3_000 })
})
