import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, createOrg, ROLE } from "../../helpers/frontier-api"

/**
 * Share panel Members tab — multi-select typeahead stages a verified user (AQU-734).
 *
 * UsernameTypeahead in multiSelect mode renders suggestion rows as checkboxes.
 * Checking a resolved Aquilla user stages them as a removable chip (the
 * single-select "Verified Aquilla user" badge journey was replaced by this).
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

  // Enter the workspace (openProject also dismisses the setup checklist
  // drawer, which would otherwise block the sidebar popover click).
  await dash.openProject(name)

  // Open Share panel.
  // Share lives in the sidebar "More" menu (sidebar cleanup).
  await alice.getByRole("button", { name: /More project options/i }).click()
  const shareBtn = alice.getByRole("button", { name: /^Share$/i })
  await expect(shareBtn).toBeVisible({ timeout: 10_000 })
  await shareBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // Ensure we're on Members tab.
  const membersTab = dialog.getByRole("button", { name: /^Members$/i })
  if (await membersTab.isVisible()) {
    await membersTab.click()
  }

  // The username input should be in "@user" mode by default.
  const usernameInput = dialog.locator('input[placeholder*="username" i]')
    .or(dialog.locator('input[placeholder="Aquilla username"]'))
  await expect(usernameInput).toBeVisible({ timeout: 8_000 })

  // Type "bob" — multi-select suggestions are checkbox rows; checking stages a chip.
  await usernameInput.fill("bob")
  const suggestion = alice.getByRole("checkbox", { name: "bob" })
  await expect(suggestion).toBeVisible({ timeout: 8_000 })
  await suggestion.click()

  // Staged chip for the verified Aquilla user appears (removable).
  await expect(dialog.getByRole("button", { name: "Remove bob" })).toBeVisible({ timeout: 8_000 })
  await expect(dialog.getByText("bob").first()).toBeVisible()

  // Dismiss.
  await alice.keyboard.press("Escape")
})
