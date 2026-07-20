import { test, expect, orgRoute } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Archived projects — archive then Restore moves the project back to active.
 *
 * The old Dashboard collapsible "Trash (N)" section is gone:
 * src/components/Dashboard.tsx is no longer routed. The flow now spans three
 * pages:
 *   - /projects/:id (ProjectOverview) — owner archives via the
 *     aria-label="More actions" overflow menu → "Archive".
 *   - /projects/archived (ArchivedProjects, "Archived" in the org sidebar) —
 *     lists archived projects, each with a "Restore" button.
 *   - /projects (ProjectsList) — the restored project reappears here.
 *
 * This spec: create a project → archive it from its Overview → it appears on
 * the Archived page → click Restore → it leaves the Archived page and is
 * back in the active projects list.
 */
test("archived project can be restored back to active projects", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `ArchiveRestore ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  // Creation lands on the project Overview (/projects/:id).
  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  await expect(alice.getByRole("heading", { name })).toBeVisible({ timeout: 10_000 })

  // Archive via the header overflow menu.
  await alice.getByRole("button", { name: /More actions/i }).click()
  const archiveItem = alice.getByRole("button", { name: /^Archive$/ })
  await expect(archiveItem).toBeVisible({ timeout: 3_000 })
  await archiveItem.click()
  await alice.waitForURL(new RegExp(`/orgs/${alice.orgId}$`), { timeout: 10_000 })

  // The Archived page (sidebar "Archived" link) lists the project.
  await alice.getByRole("link", { name: /^Archived$/ }).click()
  await alice.waitForURL(new RegExp(`/orgs/${alice.orgId}/archived$`), { timeout: 5_000 })
  const archivedRow = alice.getByText(name)
  await expect(archivedRow).toBeVisible({ timeout: 10_000 })

  // Restore it.
  await alice.getByRole("button", { name: /^Restore$/i }).click()

  // After restore the Archived page no longer lists it…
  await expect(archivedRow).not.toBeVisible({ timeout: 10_000 })

  // …and it is back in the active projects list.
  await alice.goto(orgRoute(alice))
  await alice.waitForLoadState("networkidle")
  await expect(alice.getByText(name)).toBeVisible({ timeout: 10_000 })
})
