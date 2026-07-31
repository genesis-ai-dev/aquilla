import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Rules surface — "Terminology" navigation button.
 *
 * When the rules surface is open, the in-main toolbar (header inside
 * RulesSurface, matching Terminology/Glossary) shows rules actions,
 * including a "Terminology" button that navigates to
 * /project/:id/terminology. The sidebar nav also has a "Terminology" row,
 * so the locator must scope to the Rules surface toolbar.
 *
 * This spec: navigate to the rules page → click the surface "Terminology"
 * button → verify URL changes to the terminology route.
 */
test("rules page Terminology button navigates to terminology page", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), {
    name: `RulesTermLink ${Date.now()}`,
  })
  await alice.goto(`/project/${seeded.projectId}/rules`)
  // The rules surface rendered ("Built-in checks" card).
  await expect(alice.getByText("Built-in checks")).toBeVisible({ timeout: 10_000 })

  // Click the "Terminology" button in the Rules surface toolbar (NOT the
  // sidebar nav row of the same name).
  const termBtn = alice
    .locator("header")
    .filter({ has: alice.getByRole("heading", { name: "Rules" }) })
    .getByRole("button", { name: /Terminology/i })
  await expect(termBtn).toBeVisible({ timeout: 5_000 })
  await termBtn.click()

  // URL changes to the terminology route.
  await alice.waitForURL(/\/project\/[^/]+\/terminology/, { timeout: 5_000 })
  expect(alice.url()).toMatch(/\/terminology/)
})
