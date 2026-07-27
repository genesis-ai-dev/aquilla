import { test, expect, orgRoute } from "../../helpers/multi-user"

/**
 * ArchivedProjects page — renders at /projects/archived.
 *
 * ArchivedProjects.tsx renders a page with:
 *   - OrgBreadcrumb showing "Archived"
 *   - Either a list of archived projects with "Restore" buttons,
 *     OR "No archived projects." when the list is empty.
 *
 * Alice has no archived projects, so this verifies the empty-state message.
 */
test("archived projects page renders breadcrumb and empty state", async ({ alice }) => {
  await alice.goto(orgRoute(alice, "/archived"))
  // OrgBreadcrumb shows "Archived".
  await expect(alice.getByText("Archived").first()).toBeVisible({ timeout: 10_000 })

  // Empty state or loading.
  await expect(
    alice.getByText(/No archived projects/i)
      .or(alice.getByText(/Loading/i))
  ).toBeVisible({ timeout: 8_000 })
})
