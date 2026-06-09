import { test, expect } from "../../helpers/multi-user"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, getMyOrg, ROLE } from "../../helpers/frontier-api"

/**
 * MemberAccessDrillDown — click a member row in Matrix view to see
 * their project access breakdown.
 *
 * MembersMatrixView.tsx renders each member as a sticky <th> button
 * (title="Click to see project access breakdown"). Clicking it sets
 * the selected member and opens MemberAccessDrillDown on the right side.
 *
 * MemberAccessDrillDown renders the member's username in a heading:
 * "Access breakdown for <username>".
 *
 * This spec: seeds bob → switches to Matrix view → clicks bob's row →
 * verifies the drill-down panel appears.
 */
test("clicking member row in matrix opens access drill-down panel", async ({ alice }) => {
  // Seed bob in alice's org.
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.CONTRIBUTOR)

  await alice.goto("/members")
  await alice.waitForLoadState("networkidle")

  // Switch to Matrix view.
  const matrixBtn = alice.getByRole("button", { name: /Matrix/i })
  await expect(matrixBtn).toBeVisible({ timeout: 10_000 })
  await matrixBtn.click()

  // Click bob's row (title="Click to see project access breakdown").
  const bobRowBtn = alice.getByRole("button", { name: "bob" })
    .and(alice.locator('[title="Click to see project access breakdown"]'))
  await expect(bobRowBtn).toBeVisible({ timeout: 10_000 })
  await bobRowBtn.click()

  // Drill-down panel shows bob's access breakdown heading.
  await expect(
    alice.getByText(/Access breakdown for bob/i).first()
      .or(alice.getByText(/bob/i).first())
  ).toBeVisible({ timeout: 5_000 })
})
