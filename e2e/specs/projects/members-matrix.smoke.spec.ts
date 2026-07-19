import { test, expect, orgRoute } from "../../helpers/multi-user"

/**
 * Members page (/members) — roster with expandable per-member project access.
 *
 * MembersPage.tsx renders:
 *   - h1 "Members"
 *   - MembersPanel for org role management
 *   - MemberAccessRow list for per-project access drill-down
 *
 * The Matrix tab was removed (AQU-218); project access is via expandable rows.
 */
test("members page renders roster with expandable project access", async ({ alice }) => {
  await alice.goto(orgRoute(alice, "/members"))
  await alice.waitForLoadState("networkidle")

  await expect(alice.locator("h1").filter({ hasText: /Members/i }).first()).toBeVisible({
    timeout: 10_000,
  })

  // Matrix toggle is gone.
  await expect(alice.getByRole("button", { name: /Matrix/i })).not.toBeVisible()

  // Expandable project-access section is present.
  await expect(alice.getByText(/expand a member.*per-project roles/i)).toBeVisible({
    timeout: 5_000,
  })
})
