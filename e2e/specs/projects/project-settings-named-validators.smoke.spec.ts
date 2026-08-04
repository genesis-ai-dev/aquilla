import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ValidationSettingsSection — "Named validators" multi-select combobox.
 *
 * ValidationSettingsSection.tsx renders a popup Combobox for project-member
 * usernames:
 *   - trigger id="validation-named-users" (avatar stack + comma-separated names)
 *   - options with checkbox + avatar + username
 *   - autoHighlight + Shift+Enter toggles without closing
 *
 * Selecting a member marks the form dirty, which reveals the "Save changes"
 * button in the parent ProjectSettings form.
 *
 * This spec: navigate to project settings → open the named validators
 * combobox → Shift+Enter to pick alice (auto-highlighted) → verify Save.
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
  const trigger = alice.locator("#validation-named-users")
  await expect(trigger).toBeVisible({ timeout: 10_000 })

  await trigger.click()
  const search = alice.getByRole("combobox", { name: /Search members/i })
  await expect(search).toBeVisible({ timeout: 10_000 })
  await expect(alice.getByRole("option", { name: "alice" })).toBeVisible({ timeout: 10_000 })
  await search.press("Shift+Enter")

  // Trigger shows the selected username (avatar-stack + label); popup stays open.
  await expect(trigger).toContainText("alice", { timeout: 5_000 })
  await expect(search).toBeVisible({ timeout: 5_000 })

  await alice.keyboard.press("Escape")
  const saveBtn = alice.getByRole("button", { name: /Save changes/i })
  await expect(saveBtn).toBeVisible({ timeout: 10_000 })
})
