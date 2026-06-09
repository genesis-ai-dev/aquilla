import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Project trash (soft-delete) — ProjectCard "Move to Trash" action.
 *
 * Dashboard renders ProjectCard for each project. Each card has an
 * aria-label="Project actions" button (MoreVertical) that opens a Popover
 * with a "Move to Trash" button (text, Trash2 icon). Clicking it soft-deletes
 * the project and removes it from the active list (or shows it in the Trash
 * section).
 *
 * This spec: creates two projects → clicks "Project actions" on the first →
 * clicks "Move to Trash" → verifies that project card no longer appears in
 * the active projects grid.
 */
test("Move to Trash removes project from active list", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()

  const keepName = `Keep ${Date.now()}`
  const trashName = `Trash ${Date.now()}`

  // Create two projects so the dashboard is not empty after trashing one.
  await dash.createProject({ name: keepName })
  await dash.goto()
  await dash.createProject({ name: trashName })
  await dash.goto()

  // Find the card for the project to trash.
  const trashCard = alice
    .locator("article, [data-testid='project-card']")
    .filter({ hasText: trashName })
    .first()

  // Fall back to any container element with the project name.
  const card = trashCard.or(alice.locator(".card, [class*='card']").filter({ hasText: trashName }).first())
  await expect(card).toBeVisible({ timeout: 10_000 })

  // Open the "Project actions" popover (MoreVertical button inside the card).
  const actionsBtn = card.getByRole("button", { name: /Project actions/i })
  await expect(actionsBtn).toBeVisible({ timeout: 5_000 })
  await actionsBtn.click()

  // Click "Move to Trash" in the popover.
  const moveToTrash = alice.getByRole("button", { name: /Move to Trash/i })
  await expect(moveToTrash).toBeVisible({ timeout: 3_000 })
  await moveToTrash.click()

  // Wait for the card to disappear from the active grid.
  // Either the card is gone or moved to a "Trash" section.
  await expect(
    alice.locator(".card, [class*='card'], article").filter({ hasText: trashName })
      .and(alice.locator(":not([class*='trash']):not([class*='deleted'])"))
  ).not.toBeVisible({ timeout: 8_000 })
})
