import { test, expect, orgRoute } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * TeamDetail — "Access level definitions" tooltip.
 *
 * TeamDetail.tsx renders a `?` span (aria-label="Access level definitions",
 * tabIndex=0) next to the Members section heading. Its `title` attribute
 * contains all role descriptions joined by newline.
 *
 * This spec: creates a team → navigates to /teams/:id → verifies the
 * "?" help indicator with aria-label="Access level definitions" is visible.
 */
test("team detail shows Access level definitions help indicator", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  await expect(alice.getByRole("link", { name: /^Teams$/i })).toBeVisible({ timeout: 10_000 })

  // Navigate to the teams list at /teams.
  await alice.goto(orgRoute(alice, "/teams"))
  // Create a new team.
  const createTeamBtn = alice.getByRole("button", { name: /New Team|Create.*team/i })
  await expect(createTeamBtn).toBeVisible({ timeout: 10_000 })
  await createTeamBtn.click()

  const teamNameInput = alice.locator('input[placeholder="Team name"]')
    .or(alice.locator('input[type="text"]').first())
  await expect(teamNameInput).toBeVisible({ timeout: 3_000 })
  await teamNameInput.fill(`HelpTooltip ${Date.now()}`)

  const submitBtn = alice.getByRole("button", { name: /Create|Save/i })
  await submitBtn.click()

  // Should navigate to /teams/:id.
  await alice.waitForURL(/\/teams\/[^/]+$/, { timeout: 10_000 })

  // The "Access level definitions" tooltip indicator should be visible.
  const helpSpan = alice.locator('[aria-label="Access level definitions"]')
  await expect(helpSpan).toBeVisible({ timeout: 8_000 })
})
