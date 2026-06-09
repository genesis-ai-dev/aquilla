import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * CellExpansion tabs — ArrowLeft / ArrowRight keyboard navigation.
 *
 * src/components/ui/tabs.tsx registers a keydown handler on the tab list:
 *   ArrowRight → focus next tab (wraps)
 *   ArrowLeft  → focus prev tab (wraps)
 *   Home       → focus first tab
 *   End        → focus last tab
 *
 * CellExpansion has tabs: Decay · Issues · History · BT (backtranslation).
 * (Exact tabs depend on project config; at minimum Decay and Issues appear.)
 *
 * This spec:
 *   1. Opens sample.md, expands the first cell (opens CellExpansion).
 *   2. Focuses the first tab trigger.
 *   3. Presses ArrowRight → second tab should be selected.
 *   4. Presses Home → first tab should be selected again.
 *   5. Presses End → last tab should be selected.
 */
test("CellExpansion tabs respond to ArrowRight / Home / End keyboard nav", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `TabArrow ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Open the CellExpansion panel (aria-label="Open cell details").
  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()
  await row.hover()

  const expandBtn = row.locator('button[aria-label="Open cell details"]').first()
  await expect(expandBtn).toBeVisible({ timeout: 5_000 })
  await expandBtn.click()

  // CellExpansion panel appears with a tab list.
  const tabList = alice.locator('[role="tablist"]').first()
  await expect(tabList).toBeVisible({ timeout: 5_000 })

  // Get all tab triggers.
  const tabs = tabList.locator('[role="tab"]')
  const tabCount = await tabs.count()
  expect(tabCount).toBeGreaterThanOrEqual(2)

  // Focus the first tab.
  const firstTab = tabs.first()
  await firstTab.focus()

  // Verify the first tab has focus and is selected.
  const firstTabLabel = await firstTab.textContent()

  // Press ArrowRight → second tab should get focus (and be selected).
  await alice.keyboard.press("ArrowRight")
  await alice.waitForTimeout(200)

  const secondTab = tabs.nth(1)
  const secondTabLabel = await secondTab.textContent()
  // The second tab should now be selected (aria-selected=true).
  await expect(secondTab).toHaveAttribute("aria-selected", "true", { timeout: 2_000 })
  // The first tab should no longer be selected.
  await expect(firstTab).toHaveAttribute("aria-selected", "false", { timeout: 2_000 })

  // Press Home → first tab should be selected.
  await alice.keyboard.press("Home")
  await alice.waitForTimeout(200)
  await expect(firstTab).toHaveAttribute("aria-selected", "true", { timeout: 2_000 })

  // Press End → last tab should be selected.
  await alice.keyboard.press("End")
  await alice.waitForTimeout(200)
  const lastTab = tabs.nth(tabCount - 1)
  await expect(lastTab).toHaveAttribute("aria-selected", "true", { timeout: 2_000 })
})
