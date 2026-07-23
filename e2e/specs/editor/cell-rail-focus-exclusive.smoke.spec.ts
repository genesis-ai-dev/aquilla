import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * AQU-669: the cell action rail's focus pin is EXCLUSIVE. Walking focus down
 * several cells — with the pointer parked away from all of them so hover can't
 * be the reason a rail shows — must leave exactly ONE revealed rail (the
 * currently focused row), not a stack of stale rails from every previously
 * focused cell.
 *
 * Regression: AQU-621 turned "the target cell is focused" into a pin (never
 * idle-collapsed), and the earlier idle-collapse backstop from AQU-567 was the
 * only thing sweeping up rows whose focus-out never fired. With the pin derived
 * from a single exclusive owner (row id === focused cell id) instead of each
 * row's own focus-within flag, focusing a new cell structurally un-pins the
 * previous one.
 */
test("walking focus across cells leaves exactly one revealed rail (AQU-669)", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `RailFocus ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  const revealedRails = alice.locator('[data-slot="cell-action-rail"][data-revealed="true"]')
  const aside = alice.locator("aside").first()

  // Focus row 0's target cell — its rail pins open (AQU-621) without hovering.
  await ws.activateTargetCell(0)
  // Park the pointer away from every row so hover can't be why a rail shows.
  await aside.hover()
  await expect(revealedRails).toHaveCount(1)

  // Walk focus to row 1, then row 2, parking the pointer away each time. The
  // previously focused rows must collapse as focus moves on.
  await ws.activateTargetCell(1)
  await aside.hover()
  await expect(revealedRails).toHaveCount(1)

  await ws.activateTargetCell(2)
  await aside.hover()
  await expect(revealedRails).toHaveCount(1)
  // The one revealed rail is the currently focused row's.
  await expect(
    ws.cellRow(2).locator('[data-slot="cell-action-rail"]'),
  ).toHaveAttribute("data-revealed", "true")

  // Clicking away from the editor entirely leaves no pinned rail on any row.
  await aside.click()
  await expect(revealedRails).toHaveCount(0)
})
