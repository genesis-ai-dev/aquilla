import { test, expect } from "../../helpers/multi-user"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, getMyOrg, ROLE } from "../../helpers/frontier-api"

/**
 * MemberAccessRow — expand/collapse a member's access details.
 *
 * The Members page (Roster view) renders each member as a MemberAccessRow:
 * a button showing the username + project count. Clicking it toggles a
 * disclosure showing the member's per-project access details.
 *
 * This spec: seeds bob in alice's org → navigates to /members (Roster) →
 * finds bob's row → clicks to expand → verifies the row is expanded →
 * clicks again to collapse.
 */
test("member access row expands and collapses project access details", async ({ alice }) => {
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.CONTRIBUTOR)

  await alice.goto("/members")
  await alice.waitForLoadState("networkidle")

  // Ensure we're in Roster view (default).
  const rosterBtn = alice.getByRole("button", { name: /^Roster$/i })
  if (await rosterBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await rosterBtn.click()
  }

  // Find bob's MemberAccessRow button.
  const bobRow = alice.locator("li").filter({ hasText: "bob" }).first()
  await expect(bobRow).toBeVisible({ timeout: 10_000 })

  const expandBtn = bobRow.locator("button").first()
  await expect(expandBtn).toBeVisible({ timeout: 3_000 })

  // Click to expand.
  await expandBtn.click()

  // The disclosure (project access detail) appears inside the row.
  // Look for any content that appeared after expansion.
  const disclosure = bobRow.locator("div").nth(1)
  await expect(disclosure).toBeVisible({ timeout: 3_000 })

  // Click again to collapse.
  await expandBtn.click()
  await expect(disclosure).not.toBeVisible({ timeout: 3_000 })
})
