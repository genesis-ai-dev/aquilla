import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * ProjectSettings — Retrieval support (under Validation & health).
 *
 * DecaySettingsSection on `/settings/validation`:
 *   - SettingsGroup "Retrieval support" (below Validation + Harmonization)
 *   - Input id="decay-max-hops" (confidence propagation radius — replaced the
 *     retired endorsement-target field, AD-14 amendment 2026-06-04)
 *   - Input id="decay-warn" (attention threshold)
 *
 * Changing a value marks the form dirty and shows "Save changes".
 */
test("project settings retrieval support is under validation and marks form dirty", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `DecaySettings ${Date.now()}` })

  await alice.goto(`/project/${seeded.projectId}/settings/validation`)

  const validationSection = alice.locator("#section-validation")
  const retrievalSection = alice.locator("#section-decay")
  await expect(validationSection).toBeVisible({ timeout: 10_000 })
  await expect(retrievalSection).toBeVisible({ timeout: 10_000 })
  await expect(retrievalSection.getByText(/Retrieval support/i)).toBeVisible()

  // Retrieval support must appear after Validation on this pane.
  const order = await alice.evaluate(() => {
    const validation = document.getElementById("section-validation")
    const retrieval = document.getElementById("section-decay")
    if (!validation || !retrieval) return "missing"
    return validation.compareDocumentPosition(retrieval) & Node.DOCUMENT_POSITION_FOLLOWING
      ? "after"
      : "before"
  })
  expect(order).toBe("after")

  const decayTarget = alice.locator("#decay-max-hops")
  await expect(decayTarget).toBeVisible({ timeout: 3_000 })

  const currentValue = await decayTarget.inputValue()
  const newValue = String(Number(currentValue) + 1)
  await decayTarget.fill(newValue)

  const saveBtn = alice.getByRole("button", { name: /Save changes/i })
  await expect(saveBtn).toBeVisible({ timeout: 5_000 })
})
