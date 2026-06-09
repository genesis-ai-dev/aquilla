import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * CommentsPage (/project/:id/comments).
 *
 * The page renders:
 *   - h1 containing "Comments"
 *   - "No comments yet" empty state when the project has no comments
 *
 * This spec verifies the route loads and the empty state renders.
 * Cell-level comment posting is covered by editor/comments.smoke.spec.ts.
 */
test("comments page renders empty state for a new project", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `CommentsPage ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  // Extract project id from /projects/:id URL after create.
  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/comments`)
  await alice.waitForLoadState("networkidle")

  // h1 contains "Comments"
  await expect(
    alice.locator("h1").filter({ hasText: /Comments/i })
  ).toBeVisible({ timeout: 10_000 })

  // Empty state
  await expect(
    alice.getByText(/No comments yet/i)
  ).toBeVisible({ timeout: 5_000 })
})
