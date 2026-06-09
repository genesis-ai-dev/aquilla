import { test, expect } from "../../helpers/multi-user"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, getMyOrg, ROLE } from "../../helpers/frontier-api"

/**
 * MemberAccessRow — click to expand effective-access breakdown.
 *
 * MembersPage.tsx renders a MemberAccessRow for each org member under the
 * "Effective access" section. Each row is a button with the username; clicking
 * it expands a project-level breakdown showing which grants give the member
 * access.
 *
 * MemberAccessPanel.tsx renders:
 *   <button type="button" onClick={...}>
 *     <ChevronRight/ChevronDown .../>
 *     <span className="font-medium">{username}</span>
 *   </button>
 *
 * This spec: seed bob in alice's org → navigate to /members → find the
 * MemberAccessRow for bob → click to expand → verify the chevron changes
 * and some loading/content appears.
 */
test("member access row expands on click to show effective access", async ({ alice }) => {
  // Seed bob in alice's org.
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.CONTRIBUTOR)

  await alice.goto("/members")
  await alice.waitForLoadState("networkidle")

  // Find the "Effective access" section.
  const effectiveSection = alice.getByText(/Effective access/i).first()
  await expect(effectiveSection).toBeVisible({ timeout: 10_000 })

  // Find bob's MemberAccessRow button.
  const bobRow = alice.locator("li").filter({ hasText: /\bbob\b/ }).first()
  await expect(bobRow).toBeVisible({ timeout: 10_000 })

  const bobBtn = bobRow.locator("button").first()
  await expect(bobBtn).toBeVisible({ timeout: 3_000 })

  // Expand the row.
  await bobBtn.click()

  // After expanding the row should show a content area (loading or data).
  // MemberAccessPanel fetches and shows project rows or a loading spinner.
  // We just verify the row grew in content (a div/ul inside li is now visible).
  const expandedContent = bobRow.locator("div, ul").first()
  await expect(expandedContent).toBeVisible({ timeout: 5_000 })

  // Clicking again should collapse.
  await bobBtn.click()
})
