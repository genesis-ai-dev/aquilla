import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * CommentsPage — "Back to project" button navigates to the workspace.
 *
 * CommentsPage.tsx has a "Back to project" button (ghost, sm, ArrowLeft icon)
 * in the page header. Clicking it calls navigate(`/project/${projectId}`).
 *
 * This spec: navigate to /project/:id/comments → click "Back to project" →
 * verify URL returns to /project/:id.
 */
test("CommentsPage Back to project navigates to workspace", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `CommentsBack ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/comments`)
  await alice.waitForLoadState("networkidle")

  // "Back to project" button is visible.
  const backBtn = alice.getByRole("button", { name: /Back to project/i })
  await expect(backBtn).toBeVisible({ timeout: 10_000 })

  // Click it — navigates to /project/:id.
  await backBtn.click()
  await alice.waitForURL(new RegExp(`/project/${projectId}$`), { timeout: 5_000 })
  expect(alice.url()).toMatch(/\/project\/[^/]+$/)
})
