import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Synced projects cannot rename locally because there is no server-side rename
 * endpoint. Other general settings remain editable and persist in place.
 */
test("project settings keeps synced name read-only and saves source language", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()

  const originalName = `Settings ${Date.now()}`
  await dash.createProject({ name: originalName, source: "en", target: "fr" })

  // After createProject we are at /projects/:id. Extract project id from URL.
  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  // Navigate directly to the settings page.
  await alice.goto(`/project/${projectId}/settings/general`)
  await alice.waitForLoadState("networkidle")

  const nameInput = alice.locator("#pname")
  await expect(nameInput).toBeVisible({ timeout: 10_000 })
  await expect(nameInput).toHaveValue(originalName, { timeout: 5_000 })
  await expect(nameInput).toBeDisabled()
  await expect(alice.getByText(/Renaming a synced project isn't supported yet/i)).toBeVisible()

  // AQU-538: the Languages section (target-lane registry) renders in the same
  // General group as the rest of this test's assertions — one cheap check
  // that it's present. Full add/switch/translate journey lives in
  // add-target-language.spec.ts (full suite, too long for the smoke budget).
  await expect(alice.locator("#section-languages")).toBeVisible({ timeout: 5_000 })

  const sourceLanguage = alice.locator("#sl")
  await expect(sourceLanguage).toBeEnabled()
  await sourceLanguage.fill("English (US)")

  // "Save changes" button only appears when isDirty.
  const saveBtn = alice.getByRole("button", { name: /Save changes/i })
  await expect(saveBtn).toBeVisible({ timeout: 5_000 })

  await saveBtn.click()
  // AQU-501: the General pane is expressed via `?section=general`, so match
  // the path prefix rather than anchoring on end-of-string.
  await expect(alice).toHaveURL(new RegExp(`/project/${projectId}/settings(\\?|$)`), { timeout: 10_000 })
  await expect(nameInput).toHaveValue(originalName, { timeout: 5_000 })
  await expect(sourceLanguage).toHaveValue("English (US)", { timeout: 5_000 })
  await expect(alice.getByText(/Saved: source language/i)).toBeVisible({ timeout: 10_000 })
})
