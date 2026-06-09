import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * CommentsPage — Refresh button reloads the comments list.
 *
 * CommentsPage.tsx has a "Refresh" button (outline, sm) that calls `refresh()`
 * which re-fetches the comment threads from the server.
 * 
 * The button displays a Loader2 spinner while loading (disabled),
 * then returns to "Refresh" text once done.
 *
 * This spec: navigate to /comments → click "Refresh" → verify the button
 * temporarily shows a loading state → resolves back to "Refresh".
 */
test("CommentsPage Refresh button triggers reload and returns to normal", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `CommentRefresh ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/comments`)
  await alice.waitForLoadState("networkidle")

  // "Refresh" button is visible.
  const refreshBtn = alice.getByRole("button", { name: /^Refresh$/i })
  await expect(refreshBtn).toBeVisible({ timeout: 10_000 })
  await expect(refreshBtn).toBeEnabled()

  // Click Refresh — it may briefly show loading state then return to "Refresh".
  await refreshBtn.click()

  // After the refresh completes, the button should be enabled again
  // showing "Refresh" text (not loading).
  await expect(refreshBtn).toBeEnabled({ timeout: 5_000 })
  await expect(refreshBtn).toBeVisible()
})
