import { test, expect, orgRoute } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Archived projects — archive then Restore moves the project back to active.
 *
 * The old Dashboard collapsible "Trash (N)" section is gone:
 * src/components/Dashboard.tsx is no longer routed. The flow now spans three
 * pages:
 *   - /projects/:id (ProjectOverview) — owner archives via the
 *     aria-label="More actions" overflow menu → "Archive".
 *   - /orgs/:id/archived (ArchivedProjects) — lists archived projects; Restore
 *     is a row overflow menuitem.
 *   - /orgs/:id/projects (OrgProjectsPage) — the restored project reappears.
 *
 * This spec: create a project → archive it from its Overview → it appears on
 * the Archived page → Restore → it leaves Archived and is back in Projects.
 */
test("archived project can be restored back to active projects", async ({ alice }) => {
  const name = `ArchiveRestore ${Date.now()}`
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name })
  await alice.goto(`/projects/${seeded.projectId}`)
  await expect(alice.getByRole("heading", { name })).toBeVisible({ timeout: 10_000 })

  // Archive via the header overflow menu + ConfirmActionDialog.
  await alice.getByRole("button", { name: /More actions/i }).click()
  const archiveItem = alice.getByRole("menuitem", { name: /^Archive$/ })
  await expect(archiveItem).toBeVisible({ timeout: 3_000 })
  await archiveItem.click()
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await dialog.getByRole("checkbox", { name: /I understand this project will be hidden/i }).check()
  await dialog.getByRole("button", { name: /^Archive$/ }).click()
  await alice.waitForURL(new RegExp(`/orgs/${alice.orgId}/projects/?$`), { timeout: 10_000 })

  // The Archived page (sidebar "Archived" link) lists the project.
  await alice.getByRole("link", { name: /^Archived$/ }).click()
  await alice.waitForURL(new RegExp(`/orgs/${alice.orgId}/archived$`), { timeout: 5_000 })
  const archivedRow = alice.getByRole("row").filter({ hasText: name })
  await expect(archivedRow).toBeVisible({ timeout: 10_000 })

  // Restore via the row overflow menu.
  await archivedRow.getByRole("button", { name: new RegExp(`More actions for ${name}`) }).click()
  await alice.getByRole("menuitem", { name: /^Restore$/ }).click()

  // After restore the Archived page no longer lists it…
  await expect(archivedRow).not.toBeVisible({ timeout: 10_000 })

  // …and it is back in the active projects list.
  await alice.goto(orgRoute(alice, "/projects"))
  await expect(alice.getByText(name)).toBeVisible({ timeout: 10_000 })
})
