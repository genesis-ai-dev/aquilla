import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ProjectSettings — Termbase Sharing section.
 *
 * SKIPPED: section hidden via SHOW_TERMBASE_SHARING_IN_SETTINGS in ProjectSettings.tsx
 * (2026-06-11). Re-enable when that flag is true.
 *
 * TermbaseSharingSection renders (when org is set):
 *   - CardTitle "Termbase Sharing"
 *   - Switch with aria-label="Publish termbase to org"
 *
 * This spec navigates to project settings and verifies the section renders
 * with the publish toggle visible.
 *
 * NOTE: We don't actually toggle since that calls an API endpoint that
 * persists state and could affect other tests. We just verify the UI renders.
 */
test.skip("project settings termbase sharing section renders publish toggle", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `TermShare ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/settings`)
  await alice.waitForLoadState("networkidle")

  // "Termbase Sharing" card title is visible.
  await expect(alice.getByText(/Termbase Sharing/i).first()).toBeVisible({ timeout: 10_000 })

  // The "Publish termbase to org" switch is visible.
  const publishSwitch = alice.locator('[aria-label="Publish termbase to org"]')
  await expect(publishSwitch).toBeVisible({ timeout: 5_000 })
})
