import { test, expect, orgRoute } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Project archive / restore lifecycle.
 *
 * Flow (matching ProjectOverview.tsx handleArchive / ArchivedProjects.tsx handleRestore):
 *
 *  1. Create a project → router lands on /projects/:id (overview).
 *  2. Open the ⋯ overflow menu (aria-label "More actions") → click "Archive".
 *     handleArchive() calls archiveProjectRemote, then navigate("/projects")
 *     — the app redirects to the active projects list automatically.
 *  3. The project is NOT in the active list at /projects.
 *  4. Navigate to /projects/archived — the project IS listed there with a
 *     "Restore" button rendered by ArchivedProjects.tsx.
 *  5. Click Restore → handleRestore() calls unarchiveProjectRemote + load().
 *     The project disappears from the archived list.
 *  6. Navigate to /projects — the project is back in the active list.
 */
test("archive a project and restore it", async ({ alice }) => {
  const name = `Archive ${Date.now()}`
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name })
  await alice.goto(`/projects/${seeded.projectId}`)

  // 1. Open the overflow menu and click "Archive".
  const moreBtn = alice.locator('button[aria-label="More actions"]')
  await expect(moreBtn).toBeVisible({ timeout: 5_000 })
  await moreBtn.click()

  const archiveItem = alice.getByRole("menuitem", { name: "Archive" })
  await expect(archiveItem).toBeVisible({ timeout: 3_000 })
  await archiveItem.click()

  // handleArchive() navigates to "/projects", which is a replace-redirect to the
  // org home. Wait for the settled URL, not the transient one.
  await alice.waitForURL(new RegExp(`/orgs/${alice.orgId}$`), { timeout: 10_000 })
  // 2. The project should NOT appear in the active projects list.
  await expect(alice.getByText(name).first()).not.toBeVisible({ timeout: 5_000 })

  // 3. Navigate to /projects/archived and confirm it's listed there.
  await alice.goto(orgRoute(alice, "/archived"))
  await expect(alice.getByText(name).first()).toBeVisible({ timeout: 5_000 })

  // 4. Click Restore — ArchivedProjects calls load() after success, which removes
  //    the project from the archived list in place (no navigation).
  const restoreBtn = alice.getByRole("button", { name: "Restore" }).first()
  await expect(restoreBtn).toBeVisible({ timeout: 3_000 })
  await restoreBtn.click()
  // The project should now be gone from the archived list.
  await expect(alice.getByText(name).first()).not.toBeVisible({ timeout: 5_000 })

  // 5. Navigate to /projects — the project is back in the active list.
  await alice.goto("/projects")
  await expect(alice.getByText(name).first()).toBeVisible({ timeout: 5_000 })
})
