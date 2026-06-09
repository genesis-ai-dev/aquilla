import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * RulesPage — "Back to Editor" navigation button.
 *
 * RulesPage.tsx renders a header "Back to Editor" button (ArrowLeft icon)
 * that navigates to /project/:id (the workspace).
 *
 * This spec: navigate to the rules page → click "Back to Editor" →
 * verify URL changes to the workspace route.
 */
test("rules page Back to Editor button navigates to workspace", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `RulesBack ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/rules`)
  await alice.waitForLoadState("networkidle")

  // "Translation Rules" heading confirms we're on the rules page.
  await expect(alice.getByText(/Translation Rules/i).first()).toBeVisible({ timeout: 10_000 })

  // Click "Back to Editor".
  const backBtn = alice.getByRole("button", { name: /Back to Editor/i })
  await expect(backBtn).toBeVisible({ timeout: 5_000 })
  await backBtn.click()

  // URL changes to the workspace route (/project/:id).
  await alice.waitForURL(/\/project\/[^/]+$/, { timeout: 5_000 })
  expect(alice.url()).toMatch(/\/project\/[^/]+$/)
})
