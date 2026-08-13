import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Comments — shell-owned navigation back to the editor.
 *
 * Opening Comments from the editor (sidebar) stamps `?return=` so the
 * breadcrumb includes a clickable Editor crumb. Direct /comments URLs do not.
 *
 * This spec: import a file → open comments from the sidebar → verify Editor
 * and Comments in the breadcrumb → click Editor → return to the file editor.
 */
test("comments opened from editor shows Editor in the breadcrumb", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `CommentsBack ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  await alice.locator("aside").getByRole("button", { name: /^Comments$/ }).click()
  await alice.waitForURL(/\/project\/[^/]+\/comments/, { timeout: 10_000 })
  await expect(
    alice.locator("h1").filter({ hasText: /Comments/i }),
  ).toBeVisible({ timeout: 10_000 })

  const breadcrumb = alice.getByRole("navigation", { name: /breadcrumb/i })
  const editorCrumb = breadcrumb.getByRole("link", { name: /^Editor$/i })
  await expect(editorCrumb).toBeVisible()
  await expect(breadcrumb.getByText("Comments", { exact: true })).toHaveAttribute("aria-current", "page")

  await editorCrumb.click()
  await alice.waitForURL(/\/project\/[^/]+\/editor(?:\/file\/[^/]+)?/, { timeout: 10_000 })
  await ws.waitForEditor()
  await expect(alice.locator("h1").filter({ hasText: /Comments/i })).not.toBeVisible()
})
