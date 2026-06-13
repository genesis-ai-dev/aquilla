import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, getMyOrg, ROLE } from "../../helpers/frontier-api"

/**
 * UsernameTypeahead — "Verified Aquilla user" badge.
 *
 * UsernameTypeahead.tsx renders a "verified" badge (title="Verified Aquilla
 * user", green background) when value.mode === "username" && value.resolved.
 *
 * The typeahead resolves a username when the user picks a suggestion from
 * the dropdown (handlePick sets value.resolved) — typing alone doesn't set
 * the badge. The user search is scoped to org/project-overlap users
 * (FRO-321), hence bob is seeded into alice's org first.
 *
 * This spec:
 *   1. Adds bob to alice's org (so the scoped search can find him)
 *   2. Creates a project (alice owns it) and opens its workspace
 *   3. Opens the Share panel → Members tab → types "bob" → picks the
 *      "bob" suggestion
 *   4. Verifies the "Verified Aquilla user" badge appears
 */
test("share panel username typeahead shows Verified Aquilla user badge", async ({ alice }) => {
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.CONTRIBUTOR)

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
  if (await membersTab.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await membersTab.click()
  }

  // The username input should be in "@user" mode by default.
  const usernameInput = dialog.locator('input[placeholder*="username" i]')
    .or(dialog.locator('input[placeholder="Aquilla username"]'))
  await expect(usernameInput).toBeVisible({ timeout: 8_000 })

  // Type "bob" — the typeahead suggests him; the verified badge only
  // appears once a suggestion is PICKED (value.resolved is set by
  // handlePick, not by typing alone).
  await usernameInput.fill("bob")
  const suggestion = dialog.getByRole("button", { name: "bob", exact: true })
  await expect(suggestion).toBeVisible({ timeout: 8_000 })
  await suggestion.click()

  // The "Verified Aquilla user" badge appears next to the input.
  const verifiedBadge = dialog.locator('[title="Verified Aquilla user"]')
  await expect(verifiedBadge).toBeVisible({ timeout: 8_000 })
  await expect(verifiedBadge).toContainText(/verified/i)

  // Dismiss.
  await alice.keyboard.press("Escape")
})
