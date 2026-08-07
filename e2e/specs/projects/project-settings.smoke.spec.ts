import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * AQU-765: synced projects can now be renamed from Settings — the name field
 * is editable for maintainer+ and persists through the server rename endpoint
 * (PATCH /api/v2/projects/:id), the source of truth every surface reads.
 * Other general settings save alongside in the same pass.
 */
test("project settings renames the project and saves source language", async ({ alice }) => {
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
  const nameInput = alice.locator("#pname")
  await expect(nameInput).toBeVisible({ timeout: 10_000 })
  await expect(nameInput).toHaveValue(originalName, { timeout: 5_000 })
  // The creator holds maintainer+, so the field is editable (AQU-765).
  await expect(nameInput).toBeEnabled()

  // AQU-538: the Languages section (target-lane registry) renders in the same
  // General group as the rest of this test's assertions — one cheap check
  // that it's present. Full add/switch/translate journey lives in
  // add-target-language.spec.ts (full suite, too long for the smoke budget).
  await expect(alice.locator("#section-languages")).toBeVisible({ timeout: 5_000 })

  const renamedName = `${originalName} renamed`
  await nameInput.fill(renamedName)

  const sourceLanguage = alice.locator("#sl")
  await expect(sourceLanguage).toBeEnabled()
  await sourceLanguage.fill("English (US)")

  // "Save changes" button only appears when isDirty.
  const saveBtn = alice.getByRole("button", { name: /Save changes/i })
  await expect(saveBtn).toBeVisible({ timeout: 5_000 })

  await saveBtn.click()
  // AQU-501: the General pane is expressed via `?section=general`, so match
  // the path prefix rather than anchoring on end-of-string.
  await expect(alice).toHaveURL(new RegExp(`/project/${projectId}/settings(?:/|\\?|$)`), { timeout: 10_000 })
  await expect(alice.getByText(/Saved: project title, source language/i)).toBeVisible({ timeout: 10_000 })
  await expect(nameInput).toHaveValue(renamedName, { timeout: 5_000 })
  await expect(sourceLanguage).toHaveValue("English (US)", { timeout: 5_000 })

  // The rename must have landed on the server row, not just local state —
  // reload and confirm the settings page hydrates the new name back.
  await alice.reload()
  await expect(alice.locator("#pname")).toHaveValue(renamedName, { timeout: 10_000 })
})
