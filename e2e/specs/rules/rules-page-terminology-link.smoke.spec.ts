import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * RulesPage — "Terminology" navigation button.
 *
 * RulesPage.tsx renders a header with a "Terminology" button that navigates
 * to /project/:id/terminology.
 *
 * This spec: navigate to the rules page → click "Terminology" →
 * verify URL changes to the terminology route.
 */
test("rules page Terminology button navigates to terminology page", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `RulesTermLink ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/rules`)
  await alice.waitForLoadState("networkidle")

  // "Translation Rules" heading is visible.
  await expect(alice.getByText(/Translation Rules/i).first()).toBeVisible({ timeout: 10_000 })

  // Click the "Terminology" button in the header.
  const termBtn = alice.getByRole("button", { name: /Terminology/i })
  await expect(termBtn).toBeVisible({ timeout: 5_000 })
  await termBtn.click()

  // URL changes to the terminology route.
  await alice.waitForURL(/\/project\/[^/]+\/terminology/, { timeout: 5_000 })
  expect(alice.url()).toMatch(/\/terminology/)
})
