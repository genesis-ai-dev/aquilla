import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ProjectCreateDialog — language input tooltip.
 *
 * ProjectCreateDialog.tsx has an Info tooltip button with
 * aria-label="What can I enter here?" next to the language input fields.
 * Hovering or clicking it shows tooltip content like "Any label works —
 * a BCP-47 tag, a language name, or a register description..."
 *
 * This spec: open the project create dialog → click the tooltip trigger →
 * verify the tooltip content appears.
 */
test("project create dialog language tooltip shows hint text", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()

  // Open the project create dialog.
  const newProjectBtn = alice.getByRole("button", { name: /New project/i })
  await expect(newProjectBtn).toBeVisible({ timeout: 10_000 })
  await newProjectBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // Click the "What can I enter here?" tooltip trigger button.
  const tooltipTrigger = dialog.locator('button[aria-label="What can I enter here?"]').first()
  await expect(tooltipTrigger).toBeVisible({ timeout: 3_000 })
  await tooltipTrigger.click()

  // Tooltip content appears — "Any label works" is the first sentence.
  await expect(alice.getByText(/Any label works/i).first()).toBeVisible({ timeout: 3_000 })

  // Dismiss the dialog.
  await alice.keyboard.press("Escape")
})
