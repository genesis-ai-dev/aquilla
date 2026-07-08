import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Project settings — name change persists.
 *
 * ProjectSettings.tsx:
 *  - Input id="pname" bound to the project name field.
 *  - "Save changes" button only appears when isDirty (baseline !== current).
 *  - "Save changes" saves in place.
 *
 * This spec verifies the in-place save flow: change field → "Save changes"
 * button appears → click saves without error → the settings form remains open.
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
  await alice.goto(`/project/${projectId}/settings?section=general`)
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

  // 3. Click Save — this persists in place.
  await saveBtn.click()
  // AQU-501: the General pane is expressed via `?section=general`, so match
  // the path prefix rather than anchoring on end-of-string.
  await expect(alice).toHaveURL(new RegExp(`/project/${projectId}/settings(\\?|$)`), { timeout: 10_000 })
  await expect(nameInput).toHaveValue(newName, { timeout: 5_000 })
  await expect(alice.getByText(/Saved: project name/i)).toBeVisible({ timeout: 10_000 })
})
