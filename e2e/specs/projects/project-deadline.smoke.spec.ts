import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Project overview — set and clear a deadline.
 *
 * ProjectOverview.tsx renders a "Deadline" card with:
 *   - "Set deadline" button (when no deadline is set)
 *   - date input (aria-label="Project deadline") when editing
 *   - Save / Cancel buttons
 *   - After saving: the date is shown + a "Change" and "Clear" button
 *
 * canManage is true for org owners (alice).
 */
test("project overview set deadline then clear it", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Deadline ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })

  // "Set deadline" button is visible on the overview.
  const setDeadlineBtn = alice.getByRole("button", { name: /Set deadline/i })
  await expect(setDeadlineBtn).toBeVisible({ timeout: 10_000 })
  await setDeadlineBtn.click()

  // Date input appears.
  const dateInput = alice.locator('[aria-label="Project deadline"]')
  await expect(dateInput).toBeVisible({ timeout: 3_000 })

  // Fill a future date (using ISO format).
  await dateInput.fill("2027-12-31")

  // Save the deadline.
  const saveBtn = alice.getByRole("button", { name: /^Save$/i })
  await expect(saveBtn).toBeEnabled()
  await saveBtn.click()

  // Date appears in the page; "Change" and "Clear" buttons visible.
  await expect(alice.getByText("2027-12-31").first()).toBeVisible({ timeout: 5_000 })
  const clearBtn = alice.getByRole("button", { name: /^Clear$/i })
  await expect(clearBtn).toBeVisible({ timeout: 3_000 })

  // Clear the deadline.
  await clearBtn.click()

  // "Set deadline" returns; date text is gone.
  await expect(alice.getByRole("button", { name: /Set deadline/i })).toBeVisible({ timeout: 5_000 })
  await expect(alice.getByText("2027-12-31")).not.toBeVisible({ timeout: 3_000 })
})
