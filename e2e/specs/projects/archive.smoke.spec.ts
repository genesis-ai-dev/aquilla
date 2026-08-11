import { test, expect, orgRoute } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Project archive / restore lifecycle.
 *
 * Flow (matching ProjectOverview.tsx ConfirmActionDialog + handleArchive /
 * ArchivedProjects.tsx handleRestore):
 *
 *  1. Create a project → router lands on /projects/:id (overview).
 *  2. Open the ⋯ overflow menu (aria-label "More actions") → click "Archive".
 *  3. ConfirmActionDialog opens — check acknowledgement, click "Archive".
 *     handleArchive() navigates to the org Projects table.
 *  4. The project is NOT in the active list.
 *  5. Navigate to /orgs/:id/archived — the project IS listed there; Restore
 *     lives in the row overflow menu.
 *  6. Click Restore → handleRestore() calls unarchiveProjectRemote + load().
 *     The project disappears from the archived list.
 *  7. Navigate to /orgs/:id/projects — the project is back in the active list.
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

  // ConfirmActionDialog — acknowledge + confirm.
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await dialog.getByRole("checkbox", { name: /I understand this project will be hidden/i }).check()
  await dialog.getByRole("button", { name: /^Archive$/ }).click()

  // handleArchive() navigates to the org Projects table (not Overview).
  await alice.waitForURL(new RegExp(`/orgs/${alice.orgId}/projects/?$`), { timeout: 10_000 })
  // 2. The project should NOT appear in the active projects list.
  await expect(alice.getByText(name).first()).not.toBeVisible({ timeout: 5_000 })

  // 3. Navigate to archived and confirm it's listed there.
  await alice.goto(orgRoute(alice, "/archived"))
  await expect(alice.getByText(name).first()).toBeVisible({ timeout: 5_000 })

  // 4. Restore via the row overflow menu — ArchivedProjects reloads in place.
  const row = alice.getByRole("row").filter({ hasText: name })
  await row.getByRole("button", { name: new RegExp(`More actions for ${name}`) }).click()
  await alice.getByRole("menuitem", { name: /^Restore$/ }).click()
  await expect(alice.getByText(name).first()).not.toBeVisible({ timeout: 5_000 })

  // 5. Navigate to Projects — the project is back in the active list.
  await alice.goto(orgRoute(alice, "/projects"))
  await expect(alice.getByText(name).first()).toBeVisible({ timeout: 5_000 })
})
