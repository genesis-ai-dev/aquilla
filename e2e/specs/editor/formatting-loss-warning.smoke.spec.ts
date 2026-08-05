import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * EditorTable — formatting loss warning icon.
 *
 * When sourceHasFormatting && !targetHasFormatting && translated is non-empty,
 * EditorTable.tsx renders a warning icon (AlertTriangle / TriangleAlert)
 * with title="Source has inline formatting (bold, italic, etc.) that the
 * target doesn't preserve. Formatting will be lost on export."
 *
 * sample.md row 2 is "This is a **sample** markdown file for e2e import
 * testing." — the source HTML has <strong>. If we fill the translation with
 * plain text (no bold), the formatting loss warning should appear.
 *
 * This spec:
 *   1. Import sample.md
 *   2. Find the cell that has bold source text
 *   3. Edit that cell with plain text
 *   4. Verify the formatting loss warning icon appears
 */
test("formatting loss warning appears when target drops source formatting", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `FormatLoss ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  // Find a row whose SOURCE cell contains bold text (strong/b tags).
  // We'll look for the row where source text contains "sample" (the bold word).
  // EditorTable renders rows — we look for a row whose source column shows
  // the bold text, then click the target cell and type plain text.

  // Scan the first several rows for one with source bold content.
  // sample.md row index 1 (0-based) should contain the bold word.
  // We'll just iterate rows 0–4 and check source html, or use row 1 directly.
  const row = ws.cellRow(1)
  await row.scrollIntoViewIfNeeded()

  // Edit the target cell with plain text (no bold markup).
  await ws.editCell(1, "plain translation without bold")

  // The formatting loss warning chip should appear on this row (AppTooltip wraps it).
  const warningChip = row.getByText("formatting", { exact: true })
  await expect(warningChip).toBeVisible({ timeout: 8_000 })
  await warningChip.hover()
  await expect(
    alice.getByRole("tooltip", {
      name: /Source has inline formatting that the target does not preserve/i,
    })
  ).toBeVisible({ timeout: 3_000 })
})
