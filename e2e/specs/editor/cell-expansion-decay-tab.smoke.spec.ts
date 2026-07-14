import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * CellExpansion — "Retrieval support" tab shows endorsement count and support %.
 *
 * EditorTable.tsx's cell expansion panel has a "Retrieval support" tab (value="health").
 * Switching to it reveals:
 *   - "<N> endorsements · support <N>%"
 *   - an explicit reminder that the signal prioritizes, but does not replace, review
 *
 * For a fresh unvalidated cell, endorsementCount is 0 and health is low.
 *
 * This spec: import a file → expand first cell → click the "Decay" tab →
 * verify endorsement count text appears → verify one of the attention messages
 * is visible.
 */
test("cell expansion support tab shows evidence without certifying quality", async ({ alice }) => {
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
  // expansion. Identify the expansion's tablist by its Retrieval support tab.
  const panel = alice
    .getByRole("tablist")
    .filter({ has: alice.getByRole("tab", { name: /Retrieval support/i }) })
  await expect(panel).toBeVisible({ timeout: 5_000 })

  const decayTab = panel.getByRole("tab", { name: /Retrieval support/i })
  await expect(decayTab).toBeVisible({ timeout: 3_000 })
  await decayTab.click()

  await expect(alice.getByText(/endorsement.*support/i)).toBeVisible({ timeout: 3_000 })

  const lowerSupport = alice.getByText(/Lower retrieval support/i)
  const reviewRequired = alice.getByText(/human review is still required/i)
  expect(await lowerSupport.isVisible() || await reviewRequired.isVisible()).toBe(true)
})
