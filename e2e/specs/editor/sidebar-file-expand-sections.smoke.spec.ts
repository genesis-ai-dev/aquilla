import { test, expect } from "../../helpers/multi-user"
import type { Request } from "@playwright/test"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_USFM = path.resolve(__dirname, "../../fixtures/sample.usfm")

/**
 * ExpandableFileList — expand a file row to reveal FileSectionGrid.
 *
 * FileRow.tsx has an expand toggle button (aria-label="Expand" / "Collapse").
 * The chevron only renders for section-bearing file types: fileTypeHasSections
 * (src/lib/parsers/types.ts) is scripture-only (usfm/ebible), so markdown
 * files no longer expand — this spec imports sample.usfm instead, which has
 * two chapters that become sections "Genesis 1" and "Genesis 2".
 *
 * This spec:
 *   1. Imports sample.usfm.
 *   2. Waits for the file to appear in the sidebar.
 *   3. Clicks the "Expand" button on the file row.
 *   4. Verifies the section rows (Genesis 1, Genesis 2) become visible.
 *   5. Proves expansion does not request full cell pages.
 *   6. Edits and validates a cell, then verifies the file validation bar and
 *      chapter health matrix update.
 *   7. Clicks "Collapse" — section rows disappear.
 */
test("expanding a file row reveals section rows in the sidebar", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `FileSections ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_USFM)

  // Wait for the file to appear in the sidebar.
  const sidebar = alice.locator("aside")
  await expect(
    sidebar.locator("div").filter({ hasText: /sample/i }).first()
  ).toBeVisible({ timeout: 10_000 })
  // The imported file is also the active editor file, so its normal initial
  // cell load is expected. Start measuring only after that independent work
  // has settled; requests observed below are attributable to expansion.
  await ws.waitForEditor()
  const fileRow = sidebar.locator('[data-showcase="sidebar.file"][data-showcase-name="sample.usfm"]')
  const validationBar = fileRow.getByRole("progressbar", { name: /Validation progress for sample\.usfm/i })
  await expect(validationBar).toHaveAttribute("aria-valuenow", "0")
  const initialValidationPct = Number(await validationBar.getAttribute("aria-valuenow") ?? "0")
  const cellPageReads: string[] = []
  const trackCellReads = (request: Request) => {
    const url = new URL(request.url())
    if (request.method() === "GET" && /\/files\/[^/]+\/cells$/.test(url.pathname)) {
      cellPageReads.push(request.url())
    }
  }
  alice.on("request", trackCellReads)

  // Click the "Expand" button on the file row (chevron icon).
  const expandBtn = sidebar.locator('[aria-label="Expand"]').first()
  await expect(expandBtn).toBeVisible({ timeout: 5_000 })
  await expandBtn.click()

  // FileSectionGrid loads section progress from the sync-worker.
  // sample.usfm has chapters 1 and 2 → sections "Genesis 1" and "Genesis 2".
  await expect(
    sidebar.getByText(/^Genesis 1$/).first()
  ).toBeVisible({ timeout: 10_000 })
  await expect(
    sidebar.getByText(/^Genesis 2$/).first()
  ).toBeVisible({ timeout: 3_000 })
  expect(cellPageReads).toEqual([])
  alice.off("request", trackCellReads)

  // Open chapter 1 and verify optimistic validation progress is reflected immediately.
  const gen1 = sidebar.getByRole("button", { name: "Genesis 1" }).first()
  await gen1.click()
  await ws.waitForEditor()
  // AQU-634 imports book-name/title front matter by default, so cell index 0
  // may be a book-level paratext row. Edit the first verse of the selected
  // chapter (GEN 1:1) so the GEN 1 progress bar updates.
  const verseCell = alice.locator('[data-cell-id]').filter({ hasText: /In the beginning/i }).first()
  await expect(verseCell).toBeVisible({ timeout: 10_000 })
  const verseIndex = await alice.locator("[data-cell-id]").evaluateAll((nodes, text) => {
    return nodes.findIndex((n) => (n.textContent ?? "").includes(text))
  }, "In the beginning")
  expect(verseIndex).toBeGreaterThanOrEqual(0)
  await ws.editCell(verseIndex, "Bonjour")

  // Human-authored translations are currently validated on commit. The
  // explicit helper is still safe when that has already happened and keeps
  // this journey valid if the validation policy later becomes two-step.
  await ws.validateCell(verseIndex)
  await expect.poll(async () => Number(await validationBar.getAttribute("aria-valuenow") ?? "0"), {
    timeout: 10_000,
  }).toBeGreaterThan(initialValidationPct)
  await expect(gen1.getByRole("img", { name: /human validated/i }).first()).toBeVisible({ timeout: 10_000 })

  // Collapse the file row — sections disappear.
  const collapseBtn = sidebar.locator('[aria-label="Collapse"]').first()
  await expect(collapseBtn).toBeVisible({ timeout: 3_000 })
  await collapseBtn.click()
  await expect(
    sidebar.getByText(/^Genesis 1$/).first()
  ).not.toBeVisible({ timeout: 3_000 })
})
