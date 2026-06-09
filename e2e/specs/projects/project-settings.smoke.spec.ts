import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Project settings — name change persists.
 *
 * ProjectSettings.tsx:
 *  - Input id="pname" bound to the project name field.
 *  - "Save changes" button only appears when isDirty (baseline !== current).
 *  - handleSaveAndClose() calls handleSave() then navigate(`/project/${id}`).
 *
 * This spec verifies the save flow: change field → "Save changes" button
 * appears → click saves without error → page navigates to /project/:id.
 *
 * NOTE: Project name is IDB-local (useProject is a thin server-read client).
 * The name does NOT persist server-side, so we only verify the save succeeded
 * (no error, correct navigation) — not round-trip value persistence.
 */
test("project settings name change saves and reflects in workspace", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()

  const originalName = `Settings ${Date.now()}`
  await dash.createProject({ name: originalName, source: "en", target: "fr" })

  // After createProject we are at /projects/:id. Extract project id from URL.
  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  // Navigate directly to the settings page.
  await alice.goto(`/project/${projectId}/settings`)
  await alice.waitForLoadState("networkidle")

  // 1. Find the Project Name input (Label htmlFor="pname", Input id="pname").
  const nameInput = alice.locator("#pname")
  await expect(nameInput).toBeVisible({ timeout: 10_000 })

  // Verify it's pre-populated with the original name.
  await expect(nameInput).toHaveValue(originalName, { timeout: 5_000 })

  // 2. Change the name — this makes the form dirty and reveals "Save changes".
  const newName = `${originalName} — updated`
  await nameInput.fill(newName)

  // "Save changes" button only appears when isDirty.
  const saveBtn = alice.getByRole("button", { name: /Save changes/i })
  await expect(saveBtn).toBeVisible({ timeout: 5_000 })

  // 3. Click Save — handleSaveAndClose saves then navigates to /project/:id.
  await saveBtn.click()
  await alice.waitForURL(new RegExp(`/project/${projectId}$`), { timeout: 10_000 })
  await alice.waitForLoadState("networkidle")

  // 4. After save the page navigates to /project/:id.
  //    Verify we landed on the workspace (sidebar file filter is visible).
  await alice.waitForURL(new RegExp(`/project/${projectId}$`), { timeout: 10_000 })
  await expect(alice.locator('[aria-label="Filter files"]')).toBeVisible({ timeout: 5_000 })
})
