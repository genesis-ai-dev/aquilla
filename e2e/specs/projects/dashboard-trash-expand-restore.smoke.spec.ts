import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Dashboard — Trash section expand and Restore.
 *
 * Dashboard.tsx renders a collapsible "Trash (N)" section (aria-expanded)
 * when there are trashed projects. Clicking it reveals ProjectCard cards
 * in variant="trashed" which have a "Restore" button.
 *
 * This spec: create a project → trash it → dashboard shows "Trash (1)" →
 * click to expand → "Restore" button appears → click Restore → project
 * moves back to active projects → Trash section disappears.
 */
test("dashboard Trash section expands and Restore moves project back to active", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `TrashRestore ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  // Trash the project via the ProjectCard overflow menu.
  const projectActionsBtn = alice.locator('button[aria-label="Project actions"]').first()
  await expect(projectActionsBtn).toBeVisible({ timeout: 10_000 })
  await projectActionsBtn.click()

  const moveToTrash = alice.getByRole("button", { name: /Move to Trash/i })
  await expect(moveToTrash).toBeVisible({ timeout: 5_000 })
  await moveToTrash.click()

  // The Trash section button appears.
  const trashToggle = alice.locator('button[aria-expanded]').filter({ hasText: /Trash/i })
  await expect(trashToggle).toBeVisible({ timeout: 10_000 })
  await expect(trashToggle).toHaveAttribute("aria-expanded", "false")

  // Click to expand.
  await trashToggle.click()
  await expect(trashToggle).toHaveAttribute("aria-expanded", "true", { timeout: 2_000 })

  // Restore button appears in the trashed ProjectCard.
  const restoreBtn = alice.getByRole("button", { name: /^Restore$/i })
  await expect(restoreBtn).toBeVisible({ timeout: 5_000 })
  await restoreBtn.click()

  // After restore, the Trash section disappears (no more trashed projects).
  await expect(trashToggle).not.toBeVisible({ timeout: 8_000 })

  // The project card is back in the active list.
  await expect(alice.getByText(name).first()).toBeVisible({ timeout: 5_000 })
})
