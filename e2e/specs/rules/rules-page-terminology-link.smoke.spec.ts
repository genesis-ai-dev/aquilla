import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Rules surface — "Terminology" navigation button.
 *
 * When the rules surface is open, the workspace HEADER (<header> in
 * WorkspaceHeader.tsx) shows rules actions, including a "Terminology"
 * button that navigates to /project/:id/terminology. The sidebar nav also
 * has a "Terminology" row, so the locator must scope to the header.
 *
 * This spec: navigate to the rules page → click the header "Terminology"
 * button → verify URL changes to the terminology route.
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

  // The rules surface rendered ("Built-in checks" card).
  await expect(alice.getByText("Built-in checks")).toBeVisible({ timeout: 10_000 })

  // Click the "Terminology" button in the workspace header (NOT the sidebar
  // nav row of the same name).
  const termBtn = alice.locator("header").getByRole("button", { name: /Terminology/i })
  await expect(termBtn).toBeVisible({ timeout: 5_000 })
  await termBtn.click()

  // URL changes to the terminology route.
  await alice.waitForURL(/\/project\/[^/]+\/terminology/, { timeout: 5_000 })
  expect(alice.url()).toMatch(/\/terminology/)
})
