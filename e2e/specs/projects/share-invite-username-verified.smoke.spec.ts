import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { ProjectSettings } from "../../helpers/page-objects/ProjectSettings"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, createOrg, ROLE } from "../../helpers/frontier-api"

/**
 * Add a member dialog — multi-select typeahead stages a verified user (AQU-734).
 *
 * UsernameTypeahead in multiSelect mode renders suggestion rows as checkboxes.
 * Checking a resolved Aquilla user stages them as a removable chip.
 * Bob is seeded into a separate alice-owned org so scoped search can find him
 * without making him an existing member of the project under test (AQU-321).
 */
test("share panel username typeahead shows Verified Aquilla user badge", async ({ alice }) => {
  const aliceSession = await ensureAuthState("alice")
  const searchScopeOrg = await createOrg(aliceSession.jwt, `Z Verified Badge Search Scope ${Date.now()}`)
  await addOrgMember(aliceSession.jwt, searchScopeOrg.id, "bob", ROLE.VIEWER)

  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `VerifiedBadge ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await expect(alice).toHaveURL(/\/projects\/[^/?#]+/, { timeout: 15_000 })

  const settings = new ProjectSettings(alice)
  const dialog = await settings.openAddMemberDialog(settings.projectIdFromCurrentUrl())

  const usernameInput = dialog.locator('input[placeholder*="username" i]')
    .or(dialog.locator('input[placeholder="Aquilla username"]'))
  await expect(usernameInput).toBeVisible({ timeout: 8_000 })

  await usernameInput.fill("bob")
  const suggestion = alice.getByRole("checkbox", { name: "bob" })
  await expect(suggestion).toBeVisible({ timeout: 8_000 })
  await suggestion.click()

  await expect(dialog.getByRole("button", { name: "Remove bob" })).toBeVisible({ timeout: 8_000 })
  await expect(dialog.getByText("bob").first()).toBeVisible()

  await alice.keyboard.press("Escape")
})
