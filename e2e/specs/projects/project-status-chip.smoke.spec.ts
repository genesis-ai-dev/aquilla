import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

function isoDateOffset(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return date.toISOString().slice(0, 10)
}

/**
 * ProjectOverview — deadline urgency ("Due soon" / "Overdue") shows on the
 * Deadline card only (not duplicated in the header).
 *
 * data-testid="status-chip" is on the Deadline card chip when overdue or due soon.
 */
test("status chip shows Overdue when deadline is in the past", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `StatusChip ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  await alice.waitForLoadState("networkidle")

  // Set deadline button should be visible.
  const setDeadlineBtn = alice.getByRole("button", { name: /Set deadline/i })
  await expect(setDeadlineBtn).toBeVisible({ timeout: 10_000 })
  await setDeadlineBtn.click()

  // Date input appears.
  const dateInput = alice.getByLabel(/Deadline date/i)
  await expect(dateInput).toBeVisible({ timeout: 3_000 })

  // Set a past date to trigger "Overdue".
  await dateInput.fill(isoDateOffset(-3))

  // Save.
  const saveBtn = alice.getByRole("button", { name: /^Save$/i })
  await expect(saveBtn).toBeEnabled()
  await saveBtn.click()

  // The deadline card chip should now show "Overdue".
  const chip = alice.locator('[data-testid="status-chip"]')
  await expect(chip).toBeVisible({ timeout: 10_000 })
  await expect(chip).toHaveText(/Overdue/i)
})

test("status chip shows Due soon when deadline is within 7 days", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `StatusDueSoon ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  await alice.waitForLoadState("networkidle")

  const setDeadlineBtn = alice.getByRole("button", { name: /Set deadline/i })
  await expect(setDeadlineBtn).toBeVisible({ timeout: 10_000 })
  await setDeadlineBtn.click()

  const dateInput = alice.getByLabel(/Deadline date/i)
  await expect(dateInput).toBeVisible({ timeout: 3_000 })

  // Set a date 3 days in the future to trigger "Due soon".
  await dateInput.fill(isoDateOffset(3))

  const saveBtn = alice.getByRole("button", { name: /^Save$/i })
  await expect(saveBtn).toBeEnabled()
  await saveBtn.click()

  // The deadline card chip should show "Due soon".
  const chip = alice.locator('[data-testid="status-chip"]')
  await expect(chip).toBeVisible({ timeout: 10_000 })
  await expect(chip).toHaveText(/Due soon/i)
})
