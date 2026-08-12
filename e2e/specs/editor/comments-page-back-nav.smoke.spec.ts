import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Comments — shell-owned navigation back to the editor.
 *
 * AQU-254 moved Comments inside the ProjectWorkspace shell
 * (/project/:id/comments renders ProjectWorkspace with the comments surface
 * in the center). The page's own "Back to project" button was removed —
 * breadcrumb, history arrows, and the persistent sidebar own navigation.
 * Clicking a file row calls setActiveFileId → navigate(`/project/:id/editor/file/:fileId`).
 *
 * This spec: import a file → open comments → verify the page rendered inside
 * the shell → click the file in the sidebar → verify the URL returns to the
 * editor and the comments heading is gone.
 */
test("comments surface returns to editor via sidebar file selection", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `CommentsBack ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  await alice.goto(`/project/${seeded.projectId}/comments`)
  await expect(
    alice.locator("h1").filter({ hasText: /Comments/i }),
  ).toBeVisible({ timeout: 10_000 })
  await expect(alice.getByRole("button", { name: /Back to project/i })).toHaveCount(0)

  // The shell sidebar is still mounted — click the imported file to return
  // to the editor. Target the FileRow ROOT precisely (div[tabindex="0"])
  // rather than a broad aside text click, matching the rules-surface spec.
  await alice
    .locator('aside div[tabindex="0"]')
    .filter({ has: alice.locator('button[aria-label="File actions"]') })
    .filter({ hasText: /sample/i })
    .first()
    .click()

  await alice.waitForURL(/\/project\/[^/]+\/editor\/file\/[^/]+/, { timeout: 10_000 })
  await ws.waitForEditor()
  await expect(alice.locator("h1").filter({ hasText: /Comments/i })).not.toBeVisible()
})
