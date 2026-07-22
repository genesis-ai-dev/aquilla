import { test, expect } from "../../helpers/multi-user"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, getMyOrg, ROLE } from "../../helpers/frontier-api"

/**
 * MemberAccessRow — expand/collapse a member's access details.
 *
 * The Members page renders two member lists: the roster (MembersPanel,
 * first in the DOM) and the "Project access" panel where each member is a
 * MemberAccessRow — an <li> whose toggle button's accessible name is the
 * username (chevron + username). Clicking it reveals a disclosure with the
 * member's org role + per-project grant breakdown (AD-12 effective access).
 *
 * This spec: seeds bob in alice's org → navigates to /members → expands
 * bob's access row → verifies the access details render → collapses again.
 */
test("member access row expands and collapses project access details", async ({ alice }) => {
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.CONTRIBUTOR)

  await alice.goto("/members")
  // bob's MemberAccessRow toggle — the only button whose accessible name
  // STARTS with "bob" (roster-row actions are named "Remove bob" etc.). Not
  // exact-matched: once the lazy access fetch resolves, the button's name
  // grows a summary suffix ("bob org-role only; no project overrides"), and
  // an exact "bob" locator would silently stop matching mid-test.
  const expandBtn = alice.getByRole("button", { name: /^bob\b/ })
  await expect(expandBtn).toBeVisible({ timeout: 10_000 })

  // Scope to the access-row <li> that contains the toggle (NOT the roster li,
  // which also has text "bob" and appears earlier in the DOM).
  const bobRow = alice
    .locator("li")
    .filter({ has: alice.getByRole("button", { name: /^bob\b/ }) })
    .first()
  await expect(bobRow).toBeVisible({ timeout: 3_000 })

  // Click to expand — the disclosure lazily fetches and then shows the
  // org-role line ("Org role: … — applies to every project" or "No org-wide role.").
  await expandBtn.click()
  const disclosure = bobRow.getByText(/Org role:|No org-wide role/)
  await expect(disclosure).toBeVisible({ timeout: 5_000 })

  // Click again to collapse.
  await expandBtn.click()
  await expect(disclosure).not.toBeVisible({ timeout: 3_000 })
})
