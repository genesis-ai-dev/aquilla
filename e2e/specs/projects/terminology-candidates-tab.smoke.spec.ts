import { test, expect } from "../../helpers/multi-user"
import { Glossary } from "../../helpers/page-objects/Glossary"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

test("Suggest terms adds mined candidates as inline pending rows", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `TermSuggest ${Date.now()}` })
  await openSeededProject(alice, seeded)
  await new Glossary(alice).goto(seeded.projectId)
  await alice.getByRole("button", { name: "Suggest terms" }).click()

  const pending = alice.locator('[data-testid="glossary-row"][data-status="draft"]')
  await expect(pending.first()).toBeVisible({ timeout: 15_000 })
  await expect(pending.first().getByRole("button", { name: "Accept term" })).toBeVisible()
  await expect(pending.first().getByRole("button", { name: "Dismiss term" })).toBeVisible()
})
