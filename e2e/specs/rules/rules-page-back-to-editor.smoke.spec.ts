import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Rules surface — returning to the editor.
 *
 * AQU-194 moved Rules INSIDE the ProjectWorkspace shell: /project/:id/rules
 * swaps only the main content area while the sidebar/header stay mounted.
 * The old standalone RulesPage "Back to Editor" button is gone — the way
 * back to the editor is selecting a file in the always-visible sidebar
 * (navigates to /project/:id/editor/file/:fileId, centerSurface flips to "editor").
 *
 * This spec: import a file → open the rules surface → verify it rendered
 * (Built-in checks card) → click the file in the sidebar → verify the URL
 * changes to the file route and the editor cells render again.
 */
test("rules surface returns to editor via sidebar file selection", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `RulesBack ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  await alice.goto(`/project/${seeded.projectId}/rules`)
  // The rules surface rendered inside the shell ("Built-in checks" card).
  await expect(alice.getByText("Built-in checks")).toBeVisible({ timeout: 10_000 })

  // The shell sidebar is still mounted — click the imported file to return
  // to the editor. Target the FileRow ROOT precisely (div[tabindex="0"],
  // FileRow.tsx) rather than Workspace.openFileBySubstring's broad
  // `aside div` filter: that filter also matches ancestor containers and
  // its .first() center-point click can land on empty sidebar space on the
  // rules route, never firing onSelect.
  await alice
    .locator('aside div[tabindex="0"]')
    .filter({ has: alice.locator('button[aria-label="File actions"]') })
    .filter({ hasText: /sample/i })
    .first()
    .click()

  // URL changes to the editor file route and cells render.
  await alice.waitForURL(/\/project\/[^/]+\/file\/[^/]+/, { timeout: 10_000 })
  await ws.waitForEditor()
  await expect(alice.getByText("Built-in checks")).not.toBeVisible()
})
