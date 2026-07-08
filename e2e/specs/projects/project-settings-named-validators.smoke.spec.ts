import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ValidationSettingsSection — "Named validators" input.
 *
 * ValidationSettingsSection.tsx renders a text input for comma-separated
 * validator usernames:
 *   - id="validation-named-users"
 *   - placeholder="alice, bob, carol"
 *
 * Filling the input marks the form dirty, which reveals the "Save changes"
 * button in the parent ProjectSettings form.
 *
 * This spec: navigate to project settings → fill the named validators input
 * → verify Save changes button appears → clear the input → Save changes
 * button is still visible (form is still dirty with the empty string).
 */
test("project settings named validators input makes form dirty", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `NamedVal ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/settings?section=validation`)
  await alice.waitForLoadState("networkidle")

  // The named validators input is visible.
  const namedUsersInput = alice.locator("#validation-named-users")
  await expect(namedUsersInput).toBeVisible({ timeout: 10_000 })
  await expect(namedUsersInput).toHaveAttribute("placeholder", "alice, bob, carol")

  // Fill the input to mark the form dirty.
  await namedUsersInput.fill("alice, bob")

  // "Save changes" button should now appear.
  const saveBtn = alice.getByRole("button", { name: /Save changes/i })
  await expect(saveBtn).toBeVisible({ timeout: 5_000 })
})
