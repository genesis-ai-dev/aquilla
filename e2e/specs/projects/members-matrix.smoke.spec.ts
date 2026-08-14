import { test, expect, orgRoute } from "../../helpers/multi-user"

/**
 * Members page (/members) — Teams-style roster table with expandable
 * per-member project access.
 *
 * MembersPage.tsx renders:
 *   - h1 "Members"
 *   - OrgMembersTable (search + name/email/role + row actions)
 *   - a Matrix tab for the members × projects grid
 */
test("members page renders roster with expandable project access", async ({ alice }) => {
  await alice.goto(orgRoute(alice, "/members"))
  await expect(alice.locator("h1").filter({ hasText: /Members/i }).first()).toBeVisible({
    timeout: 10_000,
  })

  await expect(alice.getByPlaceholder(/search by name or email/i)).toBeVisible({
    timeout: 5_000,
  })
  await expect(alice.getByTestId("org-members-table")).toBeVisible()

  // Alice is an org member — her row exposes the project-access chevron.
  await expect(
    alice.getByRole("button", { name: /project access for alice/i }),
  ).toBeVisible()
})
