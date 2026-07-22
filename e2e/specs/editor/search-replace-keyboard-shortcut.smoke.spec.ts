import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Ctrl+Shift+R keyboard shortcut opens search+replace panel.
 *
 * ProjectWorkspace.tsx keydown handler:
 *   if ((e.metaKey || e.ctrlKey) && e.shiftKey && key === "r")
 *     → setParallelMode("replace"), setParallelScope("project"), setParallelOpen(true)
 *
 * When the panel opens in "replace" mode, the ParallelPassagesPanel shows
 * both a "Search" input and a "Replace with" input (or a Replace section).
 *
 * This spec: open the workspace → import a file → press Ctrl+Shift+R →
 * verify the search+replace panel opens with a replace input visible.
 */
test("Ctrl+Shift+R keyboard shortcut opens the search+replace panel", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `CtrlShiftR ${Date.now()}` })
  await openSeededProject(alice, seeded)

  // Press Ctrl+Shift+R to open the search+replace panel.
  await alice.keyboard.press("Control+Shift+r")

  // The search panel should open. In "replace" mode, there's a Replace input.
  // ParallelPassagesPanel shows a pill mode selector; "Replace" mode has
  // an input with placeholder "Replacement" or "Replace with…"
  const replaceInput = alice.locator('input[placeholder="Replacement"]')
    .or(alice.locator('input[placeholder*="Replace" i]').first())
    .or(alice.locator('[aria-label*="Replace" i]').first())
  await expect(replaceInput).toBeVisible({ timeout: 8_000 })

  // Press Escape to dismiss.
  await alice.keyboard.press("Escape")
  await expect(replaceInput).not.toBeVisible({ timeout: 3_000 })
})
