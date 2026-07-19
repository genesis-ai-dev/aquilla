import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * TermbaseSharingSection — toggling the "Publish termbase to org" switch.
 *
 * SKIPPED: section hidden via SHOW_TERMBASE_SHARING_IN_SETTINGS in ProjectSettings.tsx
 * (2026-06-11). Re-enable when that flag is true.
 *
 * TermbaseSharingSection.tsx renders a Switch (aria-label="Publish termbase
 * to org") that calls togglePublish() on change. Enabling it publishes the
 * project's termbase to the org; disabling unpublishes it.
 *
 * This spec: navigate to project settings → terminology section → toggle
 * the publish switch on → verify aria-checked becomes "true" →
 * toggle off → verify aria-checked becomes "false".
 *
 * Note: the switch is only interactive when the caller is the project owner
 * (canManage = true). Alice always owns her own projects.
 */
test.skip("termbase sharing publish switch toggles on and off", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `TermShare ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  // Navigate to the project settings → termbase sharing section.
  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  // AQU-501: termbase sharing lives in the "AI & completion" sub-menu pane
  // (still feature-flag hidden — this spec stays skipped until it's shown).
  await alice.goto(`/project/${projectId}/settings/ai`)
  await alice.waitForLoadState("networkidle")

  const publishSwitch = alice.locator('[aria-label="Publish termbase to org"]')
  await expect(publishSwitch).toBeVisible({ timeout: 10_000 })

  // Capture initial state.
  const initialChecked = await publishSwitch.getAttribute("aria-checked")

  // Toggle on (click to change state).
  await publishSwitch.click()

  // State should change.
  const afterFirstClick = await publishSwitch.getAttribute("aria-checked")
  expect(afterFirstClick).not.toEqual(initialChecked)

  // Toggle back.
  await publishSwitch.click()
  await expect(publishSwitch).toHaveAttribute("aria-checked", initialChecked ?? "false", {
    timeout: 5_000,
  })
})
