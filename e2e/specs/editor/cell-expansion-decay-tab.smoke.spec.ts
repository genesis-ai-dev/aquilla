import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * CellExpansion — "Retrieval support" tab explains the available evidence.
 *
 * EditorTable.tsx's cell expansion panel has a "Retrieval support" tab (value="health").
 * Switching to it reveals:
 *   - source evidence when it is available, or an explicit unavailable state
 *   - an explicit reminder that this is support evidence, not predicted quality
 *
 * A fresh untranslated cell may not have enough source evidence yet.
 *
 * This spec: import a file → expand first cell → click "Retrieval support" →
 * verify the evidence state appears → verify it does not certify translation quality.
 */
test("cell expansion support tab shows evidence without certifying quality", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `CellDecay ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

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

  const sourceEvidence = alice.getByText(/Source evidence \d+%/i)
  const evidenceUnavailable = alice.getByText(/Pre-translation source evidence is not available yet/i)
  expect(await sourceEvidence.isVisible() || await evidenceUnavailable.isVisible()).toBe(true)

  if (await sourceEvidence.isVisible()) {
    await expect(alice.getByText(/available support, not the quality/i)).toBeVisible()
  }
})
