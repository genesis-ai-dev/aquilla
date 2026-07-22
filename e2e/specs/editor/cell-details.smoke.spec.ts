import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Cell details expansion panel.
 *
 * Each cell row has a chevron button (aria-label "Open cell details") that
 * expands an inline panel with four always-present tabs: Retrieval support,
 * BT, Recording, Issues. (A fifth Footnotes tab only appears when the cell
 * has footnotes; edit history moved out of the expansion — it now opens via
 * the "Edit history" rail button, covered by cell-history-drawer spec.)
 *
 * The chevron is in the CellActionRail — it has `alwaysShowChevron` set, which
 * means it stays at opacity-30 (partially visible) even when the row isn't
 * hovered. Still, Playwright counts opacity-30 as visible, so no hover is
 * needed to click it. However, we hover first to raise opacity to 100% and
 * ensure the pointer registers on the button.
 */
test("cell details panel expands and shows its tabs", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `CellDetails ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // 1. Hover the first cell row and click the "Open cell details" chevron.
  const row = ws.cellRow(0)
  await row.hover()
  const chevron = row.locator('button[aria-label="Open cell details"]')
  await expect(chevron).toBeVisible({ timeout: 5_000 })
  await chevron.click()

  // 2. The expansion panel should appear inside the row.
  //    It is rendered with data-state="open" once expanded.
  const panel = row.locator('[data-state="open"]')
  await expect(panel).toBeVisible({ timeout: 5_000 })

  // 3. The always-present tabs render as role="tab". (Footnotes is
  //    conditional on the cell actually having footnotes, so it's not
  //    asserted here for a plain markdown import.)
  for (const tabName of ["Retrieval support", "Back-translation", "Recording", "Issues"]) {
    await expect(panel.getByRole("tab", { name: tabName })).toBeVisible({ timeout: 3_000 })
  }

  // 4. Close the panel with the chevron (now aria-label "Close cell details").
  //    AQU-588 added a second "Close cell details" button (the in-panel X,
  //    data-cell-detail-close), so scope to the action rail to stay unambiguous.
  await row.hover()
  const closeChevron = row.locator('[data-slot="cell-action-rail"] button[aria-label="Close cell details"]')
  await expect(closeChevron).toBeVisible({ timeout: 3_000 })
  await closeChevron.click()
  await expect(panel).not.toBeVisible({ timeout: 3_000 })
})
