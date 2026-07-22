import { test, expect } from "../../helpers/multi-user"
import { Glossary } from "../../helpers/page-objects/Glossary"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

test("accepting a suggested term promotes its inline row to active", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `TermPromote ${Date.now()}` })
  await openSeededProject(alice, seeded)
  await new Glossary(alice).goto(seeded.projectId)
  await alice.getByRole("button", { name: "Suggest terms" }).click()

  const pending = alice.locator('[data-testid="glossary-row"][data-status="draft"]').first()
  await expect(pending).toBeVisible({ timeout: 15_000 })
  const conceptId = await pending.getAttribute("data-concept-id")
  expect(conceptId).toBeTruthy()
  const concept = alice.locator(`[data-testid="glossary-row"][data-concept-id="${conceptId}"]`)
  await pending.getByRole("button", { name: "Accept term" }).click()
  await expect(concept).toHaveAttribute("data-status", "active", { timeout: 8_000 })
})
