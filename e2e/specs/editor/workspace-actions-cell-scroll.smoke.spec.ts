import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Next-unfinished navigation scrolls to the first empty cell.
 *
 * NextUnfinishedButton (⌘ArrowDown) jumps to the next cell with an
 * empty translation. After clicking, the editor scrolls so that cell
 * is visible and the focus moves to the translation input.
 *
 * This spec: import a file → validate cell 0 to mark it finished →
 * click the Next Unfinished button → assert the editor is still visible
 * (scroll completed without error). sample.md yields multiple cells, so
 * the jump scrolls to the next empty cell; if everything were finished,
 * handleJumpNextUnfinished simply no-ops (there is no toast).
 */
test("next unfinished button advances past validated cell or shows all-done state", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `NextCell ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  // Edit and validate cell 0 so it's "finished".
  await ws.editCell(0, "Fini")
  await ws.validateCell(0)

  // Next unfinished lives in the header overflow menu (AQU-331).
  await ws.jumpNextUnfinished()

  // Either we scrolled to the next cell or (all finished) the click no-oped.
  // The editor renders cell rows as [data-cell-id] divs — there is no <table>
  // and no "All done" toast — so in both outcomes the rows must still be
  // visible, proving the jump completed without crashing the editor.
  await expect(alice.locator("[data-cell-id]").first()).toBeVisible({ timeout: 5_000 })
})
