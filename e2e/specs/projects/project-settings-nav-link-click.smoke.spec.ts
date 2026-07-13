import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ProjectSettings — sub-menu navigation (AQU-501).
 *
 * AQU-501 replaced the old single-scroll + scroll-spy TOC with an index of
 * labeled sub-menus (NavList/NavRow, matching org Settings): picking a
 * sub-menu navigates to `?section=<group>` and renders only that group's
 * pane, with a "‹ Settings" BackLink back to the index.
 *
 * This spec: navigate to settings (index) → click the "Validation & health"
 * sub-menu → verify the Validation card becomes visible and the index list
 * is gone → click "‹ Settings" → verify the index returns.
 */
test("settings sub-menu link navigates to its pane and back", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `SettingsNavClick ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/settings`)
  await alice.waitForLoadState("networkidle")

  // The index shows the sub-menu list, not any section's controls.
  const validationLink = alice.getByRole("link", { name: /Validation & health/i })
  await expect(validationLink).toBeVisible({ timeout: 10_000 })

  await validationLink.click()

  // The URL now carries the section param and the Validation section's own
  // card is visible.
  await expect(alice).toHaveURL(/\?section=validation/, { timeout: 5_000 })
  const validationSection = alice.locator("#section-validation")
  await expect(validationSection).toBeVisible({ timeout: 5_000 })

  // The sub-menu index is no longer shown (only the active pane).
  await expect(alice.getByRole("link", { name: /Validation & health/i })).not.toBeVisible()

  // "‹ Settings" returns to the index.
  await alice.getByRole("link", { name: /^Settings$/i }).click()
  await expect(validationSection).not.toBeVisible({ timeout: 5_000 })
  await expect(alice.getByRole("link", { name: /Validation & health/i })).toBeVisible({ timeout: 5_000 })
})
