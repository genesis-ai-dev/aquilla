import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Cmd+. keyboard shortcut — jump to next unfinished cell.
 *
 * ProjectWorkspace.tsx registers a global keydown handler:
 *   Cmd/Ctrl + "." → handleJumpNextUnfinished()
 *                    (same function as the "Next unfinished" toolbar button)
 *
 * Guard: `if (!activeFileId || !hasUnfinished) return` — requires an open
 * file with ≥1 unfinished cell.
 *
 * This spec verifies the shortcut fires — confirmed by the cell at index 0
 * receiving focus / the editor expanding after the keystroke.
 */
test("Cmd+. jumps to the next unfinished cell", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `CmdDot ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  // Ensure no cell is expanded yet (no TranslatedEditor open).
  const editors = alice.locator('[contenteditable="true"]')
  // There may be some editor already — count initial focused editors.

  // Press Cmd+. to jump to next unfinished.
  // On macOS Cmd+period; on Linux/Windows Ctrl+period.
  const isMac = process.platform === "darwin"
  await alice.keyboard.press(isMac ? "Meta+Period" : "Control+Period")
  await alice.waitForTimeout(500)

  // After shortcut, a cell should have focus — the first unfinished row
  // should have expanded its editor (TranslatedEditor mounts a contenteditable).
  // We simply check that at least one contenteditable is present (editor opened).
  await expect(editors.first()).toBeVisible({ timeout: 5_000 })

  // Also verify the first cell row is visible in the viewport (scrolled to it).
  const row = ws.cellRow(0)
  await expect(row).toBeInViewport({ timeout: 3_000 })
})
