import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Rules — settings pane navigation back to the editor.
 *
 * Rules lives under Project Settings (`/project/:id/settings/rules`).
 * Opening Settings from the editor stamps `?return=` so the breadcrumb includes
 * a clickable Editor crumb.
 *
 * This spec: import a file → open Settings from the header cog →
 * open Rules → verify Built-in checks → click Editor → return to the file editor.
 */
test("rules settings pane returns to editor via breadcrumb", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `BackNav ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  await expect(alice.getByRole("button", { name: /^Settings$/i })).toBeVisible({ timeout: 10_000 })
  await alice.getByRole("button", { name: /^Settings$/i }).click()
  await alice.waitForURL(/\/project\/[^/]+\/settings/, { timeout: 10_000 })

  await alice.getByRole("link", { name: /Rules Checks/i }).click()
  await alice.waitForURL(/\/project\/[^/]+\/settings\/rules/, { timeout: 5_000 })
  await expect(alice.getByText("Built-in checks")).toBeVisible({ timeout: 10_000 })

  const breadcrumb = alice.getByRole("navigation", { name: /breadcrumb/i })
  const editorCrumb = breadcrumb.getByRole("link", { name: /^Editor$/i }).or(
    breadcrumb.getByRole("button", { name: /^Editor$/i }),
  )
  await expect(editorCrumb).toBeVisible()
  await editorCrumb.click()

  await alice.waitForURL(/\/project\/[^/]+\/editor(?:\/file\/[^/]+)?/, { timeout: 10_000 })
  await ws.waitForEditor()
  await expect(alice.getByText("Built-in checks")).not.toBeVisible()
})
