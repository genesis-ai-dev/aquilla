import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "../../helpers/multi-user"
import {
  jwtFor,
  openSeededProject,
  readProjectedCells,
  seedProjectWithFile,
} from "../../helpers/seed-project"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Rows: 0 "The door opens." · 1 "Welcome to the house." · 2 and 3 "The door opens."
const REPEATED_MD = path.resolve(__dirname, "../../fixtures/repeated-lines.md")

const TRANSLATION = "Mlango unafunguka."

// AQU-1484: the "Repetition ×N" badge promises "Validating one fills the
// rest" (AQU-1391), but a typed translation is validated by the commit path
// itself and that validation never triggered the fill — only a click on the
// gutter check did, and a self-validated row's check no longer validates. A
// translator typed, got the green check, and the repetitions stayed empty.
// AQU-1391 shipped with this journey undriven; this is that journey.
test("typing a translation into a repeated segment fills the other repetitions once the cell is left", async ({ alice }) => {
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, {
    name: `Repetitions ${Date.now()}`,
    fixturePath: REPEATED_MD,
  })
  const ws = await openSeededProject(alice, seeded)
  const [first, unrelated, second, third] = seeded.cellIds

  await expect(ws.cellRow(0).getByTestId("source-repetition-count")).toHaveText("Repetition ×3")
  await expect(ws.cellRow(1).getByTestId("source-repetition-count")).toHaveCount(0)

  // Type and leave the cell. The edit alone validates row 0…
  await ws.editCell(0, TRANSLATION)
  await ws.expectSelfValidated(0)

  // …and the two repetitions receive the same text, with the toast that
  // offers to take it back.
  await expect(alice.getByText("Applied to 2 repeated segments")).toBeVisible({ timeout: 10_000 })
  await expect.poll(() => ws.readTargetText(2), { timeout: 10_000 }).toBe(TRANSLATION)
  await expect.poll(() => ws.readTargetText(3), { timeout: 10_000 }).toBe(TRANSLATION)

  // Filling is not signing off: only the row the translator typed in is
  // validated.
  await ws.cellRow(2).hover()
  await expect(ws.validationToggle(2)).toHaveAttribute("aria-pressed", "false")

  // The server agrees — this is the projection every other member reads.
  await expect.poll(async () => {
    const targets = await readProjectedCells(jwt, seeded, "target")
    const byId = new Map(targets.map((cell) => [cell.cellId, cell]))
    return {
      first: { value: byId.get(first)?.value, validated: byId.get(first)?.validated },
      second: { value: byId.get(second)?.value, validated: byId.get(second)?.validated },
      third: { value: byId.get(third)?.value, validated: byId.get(third)?.validated },
      unrelated: byId.get(unrelated)?.value ?? "",
    }
  }, { timeout: 10_000 }).toEqual({
    first: { value: TRANSLATION, validated: true },
    second: { value: TRANSLATION, validated: false },
    third: { value: TRANSLATION, validated: false },
    unrelated: "",
  })

  // And it survives a cold reload.
  await alice.reload()
  await ws.waitForEditor()
  await expect.poll(() => ws.readTargetText(2), { timeout: 10_000 }).toBe(TRANSLATION)
  await expect.poll(() => ws.readTargetText(3), { timeout: 10_000 }).toBe(TRANSLATION)
  await expect.poll(() => ws.readTargetText(1), { timeout: 10_000 }).not.toContain(TRANSLATION)
})

// AQU-1486: filling is not signing off — but the reviewer may now sign every
// repeat off at once. A typed edit never opens a dialog; its fill toast offers
// "Validate all", whose votes land on fills the server may not have seen yet.
test("the fill toast's Validate all signs the filled repetitions off", async ({ alice }) => {
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, {
    name: `Repetitions validate all ${Date.now()}`,
    fixturePath: REPEATED_MD,
  })
  const ws = await openSeededProject(alice, seeded)
  const [first, , second, third] = seeded.cellIds

  await ws.editCell(0, TRANSLATION)
  await expect(alice.getByText("Applied to 2 repeated segments")).toBeVisible({ timeout: 10_000 })
  await expect(ws.modalDialogs()).toHaveCount(0)
  await alice.getByRole("button", { name: "Validate all", exact: true }).click()
  // AQU-2176: the outcome is a dialog that NAMES the rows it signed off and
  // waits to be dismissed, not a toast that counts them and vanishes.
  const signedOff = alice.getByTestId("repetition-validated-dialog")
  await expect(signedOff).toBeVisible({ timeout: 10_000 })
  await expect(signedOff.getByText("Validated 2 repeated rows")).toBeVisible()
  await expect(signedOff.getByRole("listitem")).toHaveCount(2)
  await signedOff.getByRole("button", { name: "Done", exact: true }).click()
  await expect(signedOff).toHaveCount(0)

  await expect.poll(async () => {
    const targets = await readProjectedCells(jwt, seeded, "target")
    const byId = new Map(targets.map((cell) => [cell.cellId, cell]))
    return [first, second, third].map((id) => [byId.get(id)?.value, byId.get(id)?.validated])
  }, { timeout: 10_000 }).toEqual([
    [TRANSLATION, true],
    [TRANSLATION, true],
    [TRANSLATION, true],
  ])
})

// AQU-1486: "Validate text" on a selection used to validate the rows it
// covered and fill nothing. It now asks once about the selection's repeats —
// here a repeat that already carries the text but nobody has validated.
test("Validate text on a selection asks about its repetitions and can validate them too", async ({ alice }) => {
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, {
    name: `Repetitions bulk ${Date.now()}`,
    fixturePath: REPEATED_MD,
  })
  const ws = await openSeededProject(alice, seeded)
  const [, , second, third] = seeded.cellIds

  // Rows 2 and 3 receive the text, unvalidated.
  await ws.editCell(0, TRANSLATION)
  await expect.poll(() => ws.readTargetText(3), { timeout: 10_000 }).toBe(TRANSLATION)

  await ws.selectRow(2)
  await ws.validateSelection()
  const dialog = alice.getByTestId("repetition-choice-dialog")
  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: "Validate 1 more row" }).click()
  await expect(alice.getByText("Also validated 1 repeated row.")).toBeVisible({ timeout: 10_000 })

  await expect.poll(async () => {
    const targets = await readProjectedCells(jwt, seeded, "target")
    const byId = new Map(targets.map((cell) => [cell.cellId, cell]))
    return [second, third].map((id) => byId.get(id)?.validated)
  }, { timeout: 10_000 }).toEqual([true, true])
})
