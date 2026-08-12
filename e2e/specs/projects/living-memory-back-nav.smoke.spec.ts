import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Living Memory — settings pane navigation back to the editor.
 *
 * Living Memory lives under Project Settings (`/project/:id/settings/memory`).
 * Opening Settings from the editor stamps `?return=` so the breadcrumb includes
 * a clickable Editor crumb. Direct /settings/memory URLs do not.
 *
 * This spec: import a file → open Settings from the header cog →
 * open Living Memory → verify the pane renders → click Editor → return to
 * the file editor.
 */
test("living memory settings pane returns to the project editor", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `MemoryBack ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  await expect(alice.getByRole("button", { name: /^Settings$/i })).toBeVisible({ timeout: 10_000 })
  await alice.getByRole("button", { name: /^Settings$/i }).click()
  await alice.waitForURL(/\/project\/[^/]+\/settings/, { timeout: 10_000 })

  await alice.getByRole("link", { name: /Living Memory/i }).click()
  await alice.waitForURL(/\/project\/[^/]+\/settings\/memory/, { timeout: 5_000 })
  await expect(alice.getByRole("heading", { name: /Living Memory/i }).first()).toBeVisible({
    timeout: 10_000,
  })

  const breadcrumb = alice.getByRole("navigation", { name: /breadcrumb/i })
  const editorCrumb = breadcrumb.getByRole("link", { name: /^Editor$/i }).or(
    breadcrumb.getByRole("button", { name: /^Editor$/i }),
  )
  await expect(editorCrumb).toBeVisible()
  await editorCrumb.click()
  await alice.waitForURL(/\/project\/[^/]+\/editor(?:\/file\/[^/]+)?/, { timeout: 10_000 })
  await ws.waitForEditor()
  await expect(alice.getByRole("heading", { name: /Living Memory/i })).not.toBeVisible({
    timeout: 5_000,
  })
})
