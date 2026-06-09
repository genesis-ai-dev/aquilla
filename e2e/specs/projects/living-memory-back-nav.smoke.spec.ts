import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * LivingMemoryPage — "Back to project" navigation button.
 *
 * LivingMemoryPage.tsx has a button with aria-label="Back to project" (←)
 * in the page header. Clicking it calls navigate(`/project/${projectId}`),
 * returning to the project workspace.
 *
 * This spec: navigate to /project/:id/memory → click "Back to project" →
 * verify URL returns to /project/:id.
 */
test("living memory Back to project navigates to project workspace", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `MemoryBack ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  // Navigate to the Living Memory page.
  await alice.goto(`/project/${projectId}/memory`)
  await alice.waitForLoadState("networkidle")

  await expect(alice.getByRole("heading", { name: /Living Memory/i }).first()).toBeVisible({
    timeout: 10_000,
  })

  // Click "Back to project" (ArrowLeft button).
  const backBtn = alice.locator('[aria-label="Back to project"]')
  await expect(backBtn).toBeVisible({ timeout: 5_000 })
  await backBtn.click()

  // URL should return to /project/:id (workspace root).
  await alice.waitForURL(new RegExp(`/project/${projectId}$`), { timeout: 5_000 })
})
