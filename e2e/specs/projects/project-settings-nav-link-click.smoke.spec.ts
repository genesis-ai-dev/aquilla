import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ProjectSettings — SettingsNav section link click scrolls to anchor.
 *
 * SettingsNav renders a vertical list of section buttons. Clicking one
 * calls `scrollTo(id)` which smooth-scrolls the page so `#section-{id}`
 * is near the top of the viewport.
 *
 * This spec: navigate to settings → click the "Validation" section button
 * in the nav → verify the Validation card heading becomes visible in the
 * viewport (it was likely out of view since it's below the fold).
 */
test("settings nav section button scrolls to the target section", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `SettingsNavClick ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/settings`)
  await alice.waitForLoadState("networkidle")

  // The SettingsNav renders twice (desktop rail in <aside> + a lg:hidden
  // mobile copy) — scope to the rail to keep locators strict-mode safe.
  const nav = alice.locator('aside nav[aria-label="Settings sections"]')
  await expect(nav).toBeVisible({ timeout: 10_000 })

  // Click the "Validation" section link in the nav.
  const validationLink = nav.getByRole("button", { name: /^Validation$/i })
  await expect(validationLink).toBeVisible({ timeout: 5_000 })
  await validationLink.click()

  // The Validation section card should now be visible in the viewport.
  const validationSection = alice.locator("#section-validation")
  await expect(validationSection).toBeInViewport({ timeout: 3_000 })
})
