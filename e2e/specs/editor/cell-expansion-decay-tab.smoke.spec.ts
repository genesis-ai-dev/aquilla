import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * CellExpansion — "Staleness" tab shows endorsement count and health %.
 *
 * EditorTable.tsx's cell expansion panel has a "Staleness" tab (value="health";
 * renamed from "Decay" in the AD-14 derived-confidence rework).
 * Switching to it reveals:
 *   - "<N> endorsements · health <N>%"
 *   - "Needs attention" or "No attention needed" message
 *
 * For a fresh unvalidated cell, endorsementCount is 0 and health is low.
 *
 * This spec: import a file → expand first cell → click the "Decay" tab →
 * verify endorsement count text appears → verify one of the attention messages
 * is visible.
 */
test("cell expansion Decay tab shows endorsement count and health", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `CellDecay ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Open cell expansion via the "Open cell details" chevron on the first row.
  const row = ws.cellRow(0)
  const expandBtn = row.locator('[aria-label="Open cell details"]')
  await expect(expandBtn).toBeVisible({ timeout: 5_000 })
  await expandBtn.click()

  // The expansion panel opens. Don't grab the page's first tablist — the
  // "Open files" editor tab strip is also a tablist and renders before the
  // expansion. Identify the expansion's tablist by its Staleness tab.
  const panel = alice
    .getByRole("tablist")
    .filter({ has: alice.getByRole("tab", { name: /Staleness/i }) })
  await expect(panel).toBeVisible({ timeout: 5_000 })

  // Click the "Staleness" tab.
  const decayTab = panel.getByRole("tab", { name: /Staleness/i })
  await expect(decayTab).toBeVisible({ timeout: 3_000 })
  await decayTab.click()

  // Endorsement count and health % appear.
  await expect(alice.getByText(/endorsement.*health/i)).toBeVisible({ timeout: 3_000 })

  // One of the attention messages is present.
  const needsAttention = alice.getByText(/Needs attention/i)
  const noAttention = alice.getByText(/No attention needed/i)
  const hasAttentionMsg = await needsAttention.isVisible() || await noAttention.isVisible()
  expect(hasAttentionMsg).toBe(true)
})
