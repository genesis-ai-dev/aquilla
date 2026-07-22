import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Ctrl+Shift+F keyboard shortcut opens search in "project" scope.
 *
 * ProjectWorkspace.tsx keydown handler:
 *   if ((metaKey || ctrlKey) && !altKey && key === "f" && shiftKey)
 *     → setParallelScope("project"), setParallelOpen(true)
 *
 * When opened via Ctrl+Shift+F, the scope should be set to "project"
 * (the "Project" tab in ParallelPassagesPanel should have aria-selected="true").
 *
 * This spec: open workspace → Ctrl+Shift+F → verify the search panel
 * opens with the "Project" scope pill pressed.
 */
test("Ctrl+Shift+F opens search panel with project scope selected", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `CtrlShiftF ${Date.now()}` })
  await openSeededProject(alice, seeded)

  // Press Ctrl+Shift+F to open the search panel in project scope.
  await alice.keyboard.press("Control+Shift+f")

  // The search panel should open.
  const panel = alice.getByRole("dialog")
  const searchInput = panel.locator('[aria-label="Search project"]')
    .or(panel.locator('input[placeholder*="Search"]').first())
  await expect(searchInput).toBeVisible({ timeout: 8_000 })

  // The "Project" scope tab should be active (aria-selected="true").
  const projectTab = panel.getByRole("tab", { name: /^Project$/i })
  await expect(projectTab).toHaveAttribute("aria-selected", "true", { timeout: 3_000 })

  // Press Escape to dismiss.
  await alice.keyboard.press("Escape")
  await expect(searchInput).not.toBeVisible({ timeout: 3_000 })
})
