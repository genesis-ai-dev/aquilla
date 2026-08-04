import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, getMyOrg, ROLE } from "../../helpers/frontier-api"

/**
 * Project members multi-select add (AQU-734 parity on the project surfaces).
 *
 * MembersTab (embedded on the org-side project overview /projects/:id AND the
 * in-workspace /project/:id/members page — one component, two surfaces) offers
 * eligible org colleagues as checkbox rows the moment the add field is
 * focused (AQU-672 suggestions), stages checked people as removable chips
 * that survive a new search term, and grants the whole batch in ONE request.
 *
 * This spec drives the project overview instance: seed bob + carol into
 * alice's org (org-access only — no direct grant, so both are eligible),
 * create a project, check both in the add field, Add once, and expect a
 * single POST plus both rows promoted to a "direct invite" badge.
 */
test("project overview members card stages several people and adds them in one request", async ({ alice }) => {
  const aliceSession = await ensureAuthState("alice")
  const org = await getMyOrg(aliceSession.jwt)
  await addOrgMember(aliceSession.jwt, org.id, "bob", ROLE.CONTRIBUTOR)
  await addOrgMember(aliceSession.jwt, org.id, "carol", ROLE.CONTRIBUTOR)

  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Multiselect add ${Date.now()}`
  await dash.createProject({ name })
  // createProject lands on the org-side overview /projects/:id.
  await expect(alice).toHaveURL(/\/projects\/[^/?#]+/, { timeout: 15_000 })

  const membersCard = alice.locator('[data-testid="overview-members-card"]')
  await membersCard.scrollIntoViewIfNeeded()

  // Focusing the add field offers eligible org colleagues as checkbox rows —
  // no typing needed (bob and carol hold no direct grant, so both qualify).
  const addInput = membersCard.getByPlaceholder("Aquilla username")
  await addInput.click()
  const bobRow = alice.getByRole("checkbox", { name: "bob" })
  const carolRow = alice.getByRole("checkbox", { name: "carol" })
  await expect(bobRow).toBeVisible({ timeout: 10_000 })
  await expect(carolRow).toBeVisible()

  // Check both — each becomes a removable chip; the dropdown stays open.
  await bobRow.click()
  await carolRow.click()
  await expect(membersCard.getByRole("button", { name: "Remove bob" })).toBeVisible()
  await expect(membersCard.getByRole("button", { name: "Remove carol" })).toBeVisible()

  // A fresh search term must not drop the staged chips.
  await addInput.fill("zz")
  await expect(membersCard.getByRole("button", { name: "Remove bob" })).toBeVisible()
  await expect(membersCard.getByRole("button", { name: "Remove carol" })).toBeVisible()

  // One press of Add sends ONE batch request (not a per-person fan-out).
  let memberPosts = 0
  alice.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/v2\/projects\/[^/]+\/members$/.test(new URL(request.url()).pathname)
    ) {
      memberPosts += 1
    }
  })
  await membersCard.getByRole("button", { name: /^Add$/ }).click()

  // Both land in the roster without a reload: their rows gain the
  // "direct invite" badge (they were "via org" before the grant).
  await expect(
    membersCard.locator("li", { hasText: "bob" }).getByText("direct invite"),
  ).toBeVisible({ timeout: 10_000 })
  await expect(
    membersCard.locator("li", { hasText: "carol" }).getByText("direct invite"),
  ).toBeVisible()
  expect(memberPosts).toBe(1)

  // Successful adds drop from the staging chips.
  await expect(membersCard.getByRole("button", { name: "Remove bob" })).not.toBeVisible()
})
