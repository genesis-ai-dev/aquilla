import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * EditorTable — formatting loss warning (left gutter icon).
 *
 * When sourceHasFormatting && !targetHasFormatting && translated is non-empty,
 * EditorTable.tsx renders a Bold icon in the gutter badge stack
 * (data-testid="formatting-loss-warning") with a tooltip explaining that
 * formatting will be lost on export.
 *
 * sample.md row 2 is "This is a **sample** markdown file for e2e import
 * testing." — the source HTML has <strong>. If we fill the translation with
 * plain text (no bold), the formatting loss warning should appear.
 *
 * This spec:
 *   1. Import sample.md
 *   2. Find the cell that has bold source text
 *   3. Edit that cell with plain text
 *   4. Verify the formatting loss warning icon appears in the gutter
 */
test("formatting loss warning appears when target drops source formatting", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `FormatLoss ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  // Find a row whose SOURCE cell contains bold text (strong/b tags).
  // sample.md row index 1 (0-based) should contain the bold word.
  const row = ws.cellRow(1)
  await row.scrollIntoViewIfNeeded()

  // Edit the target cell with plain text (no bold markup).
  await ws.editCell(1, "plain translation without bold")

  // Icon lives in the left gutter badge stack (no longer a text chip).
  const warningIcon = row.getByTestId("formatting-loss-warning")
  await expect(warningIcon).toBeVisible({ timeout: 8_000 })
  await warningIcon.hover()
  await expect(
    alice.getByRole("tooltip", {
      name: /Source has inline formatting that the target does not preserve/i,
    })
  ).toBeVisible({ timeout: 3_000 })
})
