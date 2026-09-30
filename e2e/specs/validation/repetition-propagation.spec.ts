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
