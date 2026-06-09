import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, getMyOrg, ROLE } from "../../helpers/frontier-api"

/**
 * MembersMatrixView — "org-wide" badge for org-inherited access.
 *
 * MembersMatrixView.tsx line 241-247:
 *   {member.isOrgInherited && (
 *     <span
 *       title="Access on every project comes from org-wide role; no per-project overrides."
 *     >
 *       org-wide
 *     </span>
 *   )}
 *
 * `isOrgInherited = true` when a member has org membership but no
 * project-level role overrides (role.source === "org" for all projects).
 *
 * This spec: adds bob to alice's org (org-level only, no project role) →
 * navigates to /members Matrix view → verifies the "org-wide" badge with
 * its tooltip appears in bob's row.
 */
test("matrix view shows org-wide badge for org-inherited member", async ({ alice }) => {
  // Seed bob at org level only (no project-specific roles).
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.CONTRIBUTOR)

  // Alice creates a project (so the matrix has at least one column).
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `OrgWideBadge ${Date.now()}`
  await dash.createProject({ name })

  // Navigate to /members → Matrix view.
  await alice.goto("/members")
  await alice.waitForLoadState("networkidle")

  const matrixBtn = alice.getByRole("button", { name: /Matrix/i })
  await expect(matrixBtn).toBeVisible({ timeout: 10_000 })
  await matrixBtn.click()

  // Bob's row should show the "org-wide" badge with the tooltip.
  const orgWideBadge = alice.locator(
    'span[title="Access on every project comes from org-wide role; no per-project overrides."]'
  )
  await expect(orgWideBadge).toBeVisible({ timeout: 10_000 })
  await expect(orgWideBadge).toContainText("org-wide")
})
