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
 * two chapters that become sections "GEN 1" and "GEN 2" (section labels come
 * from the canonical reference, e.g. "GEN 1:1" → "GEN 1").
 *
 * This spec:
 *   1. Imports sample.usfm.
 *   2. Waits for the file to appear in the sidebar.
 *   3. Clicks the "Expand" button on the file row.
 *   4. Verifies the section rows (GEN 1, GEN 2) become visible.
 *   5. Proves expansion does not request full cell pages.
 *   6. Edits and validates a cell, then verifies both progress bars update.
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
  // sample.usfm has chapters 1 and 2 → sections "GEN 1" and "GEN 2".
  await expect(
    sidebar.getByText(/^GEN 1$/).first()
  ).toBeVisible({ timeout: 10_000 })
  await expect(
    sidebar.getByText(/^GEN 2$/).first()
  ).toBeVisible({ timeout: 3_000 })
  expect(cellPageReads).toEqual([])
  alice.off("request", trackCellReads)

  // Open chapter 1 and verify optimistic progress is reflected immediately.
  const gen1 = sidebar.getByRole("button", { name: /GEN 1/i }).first()
  const translatedBar = gen1.locator("span.bg-amber-500")
  const validatedBar = gen1.locator("span.bg-emerald-500")
  await gen1.click()
  await ws.waitForEditor()
  // AQU-585 filters book-name/title front matter from editor cells, so the
  // first row in the selected chapter is GEN 1:1.
  await ws.editCell(0, "Bonjour")
  await expect.poll(async () => Number.parseFloat((await translatedBar.getAttribute("style"))?.match(/[\d.]+/)?.[0] ?? "0"), {
    timeout: 10_000,
  }).toBeGreaterThan(0)

  await ws.validateCell(0)
  await expect.poll(async () => Number.parseFloat((await validatedBar.getAttribute("style"))?.match(/[\d.]+/)?.[0] ?? "0"), {
    timeout: 10_000,
  }).toBeGreaterThan(0)

  // Collapse the file row — sections disappear.
  const collapseBtn = sidebar.locator('[aria-label="Collapse"]').first()
  await expect(collapseBtn).toBeVisible({ timeout: 3_000 })
  await collapseBtn.click()
  await expect(
    sidebar.getByText(/^GEN 1$/).first()
  ).not.toBeVisible({ timeout: 3_000 })
})
