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
 * "BT" tab. When the cell has no back-translation and no translated value,
 * the "Generate" button is disabled.  After adding a translation, the
 * "Generate" button becomes enabled (but actually triggering AI is
 * out-of-scope for this smoke spec — we only verify the button appears).
 *
 * This spec: open cell details → switch to BT tab → assert "Generate"
 * button is visible (disabled until cell has content — just verifying
 * the tab and button exist).
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

  // "Generate" button appears (may be disabled when cell has no translation).
  const generateBtn = alice.getByRole("button", { name: /Generate/i }).first()
  await expect(generateBtn).toBeVisible({ timeout: 5_000 })
})
