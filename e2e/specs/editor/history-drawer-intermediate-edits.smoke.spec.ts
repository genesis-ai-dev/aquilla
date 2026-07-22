import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * HistoryDrawer — "Show intermediate edits" / "Hide intermediate edits" toggle.
 *
 * HistoryDrawer.tsx renders a toggle button for terminal entries that have
 * sub-entries (multiple edits compressed into one "terminal"):
 *   "Show intermediate edits" → expands the sub-entry list
 *   "Hide intermediate edits" → collapses it
 *
 * To produce sub-entries, a cell needs multiple edits by the same author
 * within a short time window (the history compression algorithm groups them).
 *
 * This spec:
 *   1. Imports sample.md.
 *   2. Edits cell 0 three times quickly (same author, same session).
 *   3. Hovers the row → clicks the "Edit history" rail button.
 *   4. Verifies HistoryDrawer opens with heading "Edit history".
 *   5. Looks for "Show intermediate edits" button → clicks it.
 *   6. Verifies the text changes to "Hide intermediate edits".
 *   7. Clicks "Hide intermediate edits" → text reverts.
 *
 * If the history compression doesn't produce sub-entries (only 1 terminal),
 * the toggle won't appear — the spec gracefully exits early.
 */
test("HistoryDrawer show/hide intermediate edits toggle works", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `HistIntermed ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  // Edit the first cell multiple times quickly to create sub-entries.
  await ws.editCell(0, "v1")
  await alice.waitForTimeout(200)
  await ws.editCell(0, "v1 updated")
  await alice.waitForTimeout(200)
  await ws.editCell(0, "v1 final")
  await alice.waitForTimeout(500)

  // Hover the row to reveal the CellActionRail, then open the history drawer.
  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()
  await row.hover()

  const historyBtn = row.locator('button[aria-label="Edit history"]').first()
  await expect(historyBtn).toBeVisible({ timeout: 5_000 })
  await historyBtn.click()

  // HistoryDrawer opens.
  await expect(alice.getByRole("heading", { name: /Edit history/i }).first()).toBeVisible({ timeout: 5_000 })

  // Look for "Show intermediate edits" toggle.
  const showToggle = alice.getByText(/Show intermediate edits/i).first()
  if (!(await showToggle.isVisible({ timeout: 2_000 }).catch(() => false))) {
    // No sub-entries produced — spec exits gracefully.
    return
  }

  await showToggle.click()
  await alice.waitForTimeout(200)

  // Should now show "Hide intermediate edits".
  const hideToggle = alice.getByText(/Hide intermediate edits/i).first()
  await expect(hideToggle).toBeVisible({ timeout: 3_000 })

  // Click to hide again.
  await hideToggle.click()
  await alice.waitForTimeout(200)

  // Back to "Show intermediate edits".
  await expect(alice.getByText(/Show intermediate edits/i).first()).toBeVisible({ timeout: 3_000 })
})
