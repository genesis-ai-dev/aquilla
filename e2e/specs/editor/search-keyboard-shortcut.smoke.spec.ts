import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Cmd+K / Ctrl+K keyboard shortcut opens the search panel.
 *
 * ProjectWorkspace.tsx keydown handler:
 *   if ((e.metaKey || e.ctrlKey) && !e.altKey && (key === "f" || key === "k"))
 *     → opens ParallelPassagesPanel
 *
 * This spec: open the workspace → import a file → press Ctrl+K →
 * verify the search input panel becomes visible.
 *
 * JOURNEYS.md gap: "Editor: Cmd+K search" (keyboard shortcut path).
 */
test("Ctrl+K keyboard shortcut opens the search panel", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `CmdK ${Date.now()}` })
  await openSeededProject(alice, seeded)

  // Press Ctrl+K to open the search panel.
  await alice.keyboard.press("Control+k")

  // The search input in ParallelPassagesPanel should appear.
  // It has aria-label matching the input placeholder or a labelled search field.
  const searchInput = alice.locator('[aria-label="Search project"]')
    .or(alice.locator('[aria-label="Search file"]'))
    .or(alice.locator('input[placeholder*="Search"]').first())
  await expect(searchInput).toBeVisible({ timeout: 5_000 })

  // Press Escape to dismiss — panel should close.
  await alice.keyboard.press("Escape")
  await expect(searchInput).not.toBeVisible({ timeout: 3_000 })
})
