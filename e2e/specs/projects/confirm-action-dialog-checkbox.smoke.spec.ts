import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ConfirmActionDialog — checkbox must be checked before Confirm is enabled.
 *
 * Dashboard.tsx uses ConfirmActionDialog for "Move to Trash". Clicking
 * "Move to Trash" in the ProjectCard overflow menu opens a dialog with:
 *   - Title "Move to Trash"
 *   - A checkbox: "I understand collaborators lose access until the project is restored."
 *   - A disabled "Move to Trash" confirm button (disabled until checkbox is checked)
 *
 * This spec: creates a project → opens the overflow menu → clicks
 * "Move to Trash" → verifies the dialog opens → verifies the confirm button
 * is disabled → checks the checkbox → verifies the confirm button becomes
 * enabled.
 */
test("confirm action dialog confirm button enabled only after checking checkbox", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()

  const projectName = `ConfirmDialog ${Date.now()}`
  await dash.createProject({ name: projectName })
  await dash.goto()

  // Find the project card.
  const card = alice.locator(".card, [class*='card'], article, [class*='Card']")
    .filter({ hasText: projectName })
    .first()
  await expect(card).toBeVisible({ timeout: 10_000 })

  // Open the "Project actions" popover.
  const actionsBtn = card.getByRole("button", { name: /Project actions/i })
  await expect(actionsBtn).toBeVisible({ timeout: 5_000 })
  await actionsBtn.click()

  // Click "Move to Trash" — opens the ConfirmActionDialog.
  const moveToTrashBtn = alice.getByRole("button", { name: /Move to Trash/i })
  await expect(moveToTrashBtn).toBeVisible({ timeout: 3_000 })
  await moveToTrashBtn.click()

  // The ConfirmActionDialog opens.
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog.getByRole("heading", { name: /Move to Trash/i })).toBeVisible()

  // The confirm button is disabled before the checkbox is checked.
  const confirmBtn = dialog.getByRole("button", { name: /Move to Trash/i })
  await expect(confirmBtn).toBeDisabled({ timeout: 3_000 })

  // Check the "I understand" checkbox.
  const checkbox = dialog.locator('input[type="checkbox"]')
  await expect(checkbox).toBeVisible({ timeout: 3_000 })
  await checkbox.check()

  // Confirm button is now enabled.
  await expect(confirmBtn).toBeEnabled({ timeout: 2_000 })

  // Cancel to avoid actually trashing the project.
  await dialog.getByRole("button", { name: /Cancel/i }).click()
  await expect(dialog).not.toBeVisible({ timeout: 3_000 })
})
