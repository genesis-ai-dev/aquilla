import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Rules settings pane — "Terminology" navigation button.
 *
 * The Rules pane in project settings has a Terminology button that navigates
 * to /project/:id/terminology (still a workspace overlay).
 *
 * This spec: navigate to /settings/rules (via the legacy /rules redirect) →
 * click Terminology → land on the terminology route.
 */
test("rules page Terminology button navigates to terminology page", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), {
    name: `RulesTermLink ${Date.now()}`,
  })
  await alice.goto(`/project/${seeded.projectId}/rules`)
  await expect(alice.getByText("Built-in checks")).toBeVisible({ timeout: 10_000 })

  const termBtn = alice.getByRole("button", { name: /Terminology/i })
  await expect(termBtn).toBeVisible({ timeout: 5_000 })
  await termBtn.click()

  await alice.waitForURL(/\/project\/[^/]+\/terminology/, { timeout: 5_000 })
  expect(alice.url()).toMatch(/\/terminology/)
})
