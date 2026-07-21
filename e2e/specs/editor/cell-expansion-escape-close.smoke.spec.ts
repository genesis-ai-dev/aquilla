import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * CellExpansion — Escape key closes the expansion panel.
 *
 * CellExpansion.tsx attaches a keydown listener to its wrapper element:
 *   if (e.key === "Escape") { e.stopPropagation(); onClose?.() }
 *
 * This is a distinct close path from clicking the "Close cell details" button
 * (tested in cell-details.smoke.spec.ts). Verifying it ensures the keyboard
 * close handler is wired correctly and doesn't regress.
 *
 * This spec:
 *   1. Imports sample.md and opens the editor.
 *   2. Hovers a cell row and clicks "Open cell details".
 *   3. Verifies the expansion panel is open.
 *   4. Presses Escape while focus is inside the panel.
 *   5. Verifies the expansion panel closes.
 */
test("Escape key closes the cell expansion panel", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `ExpansionEsc ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Hover the first row and open cell details.
  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()
  await row.hover()

  const expandBtn = row.getByRole("button", { name: /Open cell details/i })
  await expect(expandBtn).toBeVisible({ timeout: 5_000 })
  await expandBtn.click()

  // The "Close cell details" button confirms the panel is open.
  // The action rail and the panel both expose "Close cell details". The
  // panel-specific marker is stable and disappears when Escape closes it.
  const closeBtn = row.locator("[data-cell-detail-close]")
  await expect(closeBtn).toBeVisible({ timeout: 5_000 })

  // Press Escape while focus is INSIDE the panel — the keydown listener lives
  // on the expansion wrapper, and the "Close cell details" chevron is owned by
  // the action rail (outside the wrapper), so focusing it would not work.
  // Focus one of the expansion's tabs instead.
  const panelTab = alice.getByRole("tab", { name: /Retrieval support/i }).first()
  await expect(panelTab).toBeVisible({ timeout: 5_000 })
  await panelTab.focus()
  await alice.keyboard.press("Escape")

  // The close button should disappear (panel closed).
  await expect(closeBtn).not.toBeVisible({ timeout: 5_000 })
})
