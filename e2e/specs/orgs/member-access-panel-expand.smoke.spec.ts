import { test, expect, orgRoute } from "../../helpers/multi-user"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, getMyOrg, ROLE } from "../../helpers/frontier-api"

/**
 * MemberAccessSubRow — expand/collapse a member's access details.
 *
 * The org Members page renders a Teams-style DataTable. Each row has a
 * "Project access for <username>" chevron that expands a sub-row with the
 * member's org role + per-project grant breakdown (AD-12 effective access).
 *
 * This spec: seeds bob in alice's org → navigates to /members → expands
 * bob's access row → verifies the access details render → collapses again.
 */
test("member access row expands and collapses project access details", async ({ alice }) => {
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.CONTRIBUTOR)

  await alice.goto(orgRoute(alice, "/members"))
  const expandBtn = alice.getByRole("button", { name: /project access for bob/i })
  await expect(expandBtn).toBeVisible({ timeout: 10_000 })

  await expandBtn.click()
  const disclosure = alice.getByText(/Org role:|No org-wide role/)
  await expect(disclosure).toBeVisible({ timeout: 5_000 })

  await expandBtn.click()
  await expect(disclosure).not.toBeVisible({ timeout: 3_000 })
})
