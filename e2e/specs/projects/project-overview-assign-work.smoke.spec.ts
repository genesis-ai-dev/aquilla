import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * ProjectOverview — Assign work form.
 *
 * ProjectOverview.tsx renders the AssignWork component (when the project has
 * files and the user is canManage). The component:
 *   - Shows an "Assign…" button (collapsed).
 *   - Clicking opens an inline form (role="group" aria-label="Assign work")
 *     with a file/chapter picker and member select.
 *   - "Cancel" collapses back to the "Assign…" button.
 */
test("project overview assign work form opens and Cancel collapses it", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `AssignWork ${Date.now()}` })

  // Navigate to the project overview.
  await alice.goto(`/projects/${seeded.projectId}`)
  // "Assign…" button is visible.
  const assignBtn = alice.getByRole("button", { name: /^Assign…$/i })
  await expect(assignBtn).toBeVisible({ timeout: 10_000 })
  await assignBtn.click()

  // Inline form opens with aria-label "Assign work".
  const form = alice.locator('[role="group"][aria-label="Assign work"]')
  await expect(form).toBeVisible({ timeout: 3_000 })

  // Cancel collapses it.
  const cancelBtn = form.getByRole("button", { name: /^Cancel$/i })
  await expect(cancelBtn).toBeVisible({ timeout: 3_000 })
  await cancelBtn.click()
  await expect(form).not.toBeVisible({ timeout: 2_000 })
  await expect(assignBtn).toBeVisible({ timeout: 2_000 })
})
