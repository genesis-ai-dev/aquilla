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
 * The typeahead resolves a username when the user types a valid existing
 * username (e.g. "bob") and the API returns a match.
 *
 * This spec:
 *   1. Creates a project (alice owns it)
 *   2. Adds bob to alice's org (so he's a valid Aquilla user)
 *   3. Opens the Share panel → Members tab → types "bob" in the username input
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

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}`)
  await alice.waitForLoadState("networkidle")

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

  // Type "bob" — should resolve to a verified user.
  await usernameInput.fill("bob")

  // Wait for the "Verified Aquilla user" badge to appear.
  const verifiedBadge = dialog.locator('[title="Verified Aquilla user"]')
  await expect(verifiedBadge).toBeVisible({ timeout: 8_000 })
  await expect(verifiedBadge).toContainText(/verified/i)

  // Dismiss.
  await alice.keyboard.press("Escape")
})
