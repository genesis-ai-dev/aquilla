import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Cell expansion panel — BT (Backtranslation) tab.
 *
 * The CellExpansion panel (opened by "Open cell details" chevron) has a
 * "Back-translation" tab. A cell with a translation but no back-translation
 * shows a "Read it back" generate affordance (an empty cell shows only a
 * "Translate this cell to read it back" hint). Actually triggering generation
 * is out-of-scope for this smoke spec — we only verify the button appears.
 *
 * This spec: translate cell 0 → open cell details → switch to the
 * Back-translation tab → assert a BT control ("Read it back" or "Edit the
 * back-translation") is visible.
 */
test("BT tab is accessible from cell expansion panel", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `BtTab ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()
  // The BT generate affordance ("Read it back") only renders once the cell has
  // a translation — an empty cell shows a "Translate this cell to read it back"
  // hint instead. Add a translation so the button is present to assert on.
  await ws.editCell(0, "Translation for BT tab test")

  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()
  await row.hover()

  // Open cell details.
  const expandBtn = row.getByRole("button", { name: /Open cell details/i })
  await expect(expandBtn).toBeVisible({ timeout: 5_000 })
  await expandBtn.click()

  // Switch to the Back-translation tab (formerly labelled "BT").
  const btTab = alice.getByRole("button", { name: /back-translation/i })
    .or(alice.getByRole("tab", { name: /back-translation/i }))
  await expect(btTab.first()).toBeVisible({ timeout: 5_000 })
  await btTab.first().click()

  // A translated cell shows BT controls in the panel: the "Read it back"
  // generate affordance (formerly "Generate") when there's no back-translation
  // yet, or the "Edit the back-translation" control once one exists (editing the
  // cell can auto-generate a reading in-session). Either proves the tab renders.
  const btPanel = alice.getByRole("tabpanel", { name: /back-translation/i })
  const readItBack = btPanel.getByRole("button", { name: /read it back|reading it back/i })
  const editBt = btPanel.getByRole("button", { name: "Edit the back-translation" })
  await expect(readItBack.or(editBt).first()).toBeVisible({ timeout: 5_000 })
})
