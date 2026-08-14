import { test, expect, orgRoute } from "../../helpers/multi-user"

/**
 * Archived page — renders at /orgs/:id/archived with Projects / Recently
 * deleted tabs.
 *
 * ArchivedProjects.tsx renders:
 *   - OrgBreadcrumb showing "Archived"
 *   - Tabs: Projects (archived projects table) and Recently deleted
 *     (deleted files with a Project column)
 *   - Empty states when either list is empty
 *
 * Alice has no archived projects and no deleted files, so this verifies
 * both empty-state messages.
 */
test("archived page renders tabs, projects empty state, and recently deleted empty state", async ({ alice }) => {
  await alice.goto(orgRoute(alice, "/archived"))
  await expect(alice.getByText("Archived").first()).toBeVisible({ timeout: 10_000 })

  await expect(alice.getByRole("tab", { name: "Projects" })).toBeVisible({ timeout: 10_000 })
  await expect(alice.getByRole("tab", { name: "Recently deleted" })).toBeVisible()

  await expect(alice.getByText(/No archived projects/i)).toBeVisible({ timeout: 10_000 })

  await alice.getByRole("tab", { name: "Recently deleted" }).click()
  await expect(alice).toHaveURL(/\/archived\/files$/)
  await expect(alice.getByText(/No recently deleted files/i)).toBeVisible({ timeout: 10_000 })
})
