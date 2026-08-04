import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ValidationSettingsSection — "Named validators" multi-select combobox.
 *
 * ValidationSettingsSection.tsx renders a Combobox (multiple + chips) for
 * project-member usernames:
 *   - input id="validation-named-users"
 *   - options drawn from the project members roster
 *
 * Selecting a member marks the form dirty, which reveals the "Save changes"
 * button in the parent ProjectSettings form.
 *
 * This spec: navigate to project settings → open the named validators
 * combobox → pick alice (project creator) → verify Save changes appears.
 */
test("project settings named validators combobox makes form dirty", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `NamedVal ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/settings/validation`)
  const namedUsersInput = alice.locator("#validation-named-users")
  await expect(namedUsersInput).toBeVisible({ timeout: 10_000 })

  // Wait for the members roster to populate the combobox options.
  await namedUsersInput.click()
  const aliceOption = alice.getByRole("option", { name: "alice" })
  await expect(aliceOption).toBeVisible({ timeout: 10_000 })
  await aliceOption.click()

  // Chip for the selected member should appear (controlled from form state).
  await expect(alice.locator('[data-slot="combobox-chip"]', { hasText: "alice" })).toBeVisible({
    timeout: 5_000,
  })

  // Close the popup so header actions aren't obscured, then assert dirty.
  await alice.keyboard.press("Escape")
  const saveBtn = alice.getByRole("button", { name: /Save changes/i })
  await expect(saveBtn).toBeVisible({ timeout: 10_000 })
})
