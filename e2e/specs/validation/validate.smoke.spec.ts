import { expect, test } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

// Restored codex behaviour (2026-07): directly editing a target cell
// auto-validates it — "a human has touched it" — in the same gesture, with no
// separate click. Aquilla had regressed to leaving a freshly typed cell
// unvalidated until the translator clicked the health ring; this asserts the
// edit alone flips the cell to self-validated (emerald).
test("directly editing a target cell auto-validates it (self-validated, emerald)", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `Validate ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  // Type a translation into an empty cell. This commits the text AND, per the
  // restored behaviour, marks the cell validated by the current user.
  await ws.editCell(0, "Test translation")

  // The edit alone flips the cell to self-validated — no manual validate click.
  await ws.expectSelfValidated(0)

  // The affordance now offers "remove your validation" — the popover branch
  // that only renders once the cell actually has a validator, proving the
  // green state is a real self-validation and not just styling.
  const row = ws.cellRow(0)
  await row.hover()
  const validatedButton = row.getByRole("button", { name: /remove your validation/i }).first()
  await expect(validatedButton).toHaveAttribute("aria-pressed", "true")
  await expect(validatedButton).not.toHaveAttribute("title", /.+/)
})
