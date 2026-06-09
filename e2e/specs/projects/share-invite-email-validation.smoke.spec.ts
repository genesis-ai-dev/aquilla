import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * SharePanel InviteLinkTab — email validation error on invalid input.
 *
 * SharePanel.tsx InviteLinkTab has an optional recipient email input
 * (id="invite-email"). When a non-empty, syntactically invalid email is
 * entered and the user clicks "Create link", handleCreate() sets emailError:
 *   "Enter a valid email address, or leave blank for an open link."
 *
 * This spec: open share dialog → switch to Invite link tab → type an
 * invalid email → click Create link → verify the error message appears.
 */
test("share invite link email validation error shown for invalid email", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `ShareEmailVal ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  // Open the share dialog from the project card.
  await dash.goto()
  const card = alice.locator("[class*='card'], article, [class*='Card']")
    .filter({ hasText: name })
    .first()
  await expect(card).toBeVisible({ timeout: 10_000 })

  const shareBtn = card.getByRole("button", { name: /Share/i })
    .or(card.locator('[aria-label*="Share"]'))
  await expect(shareBtn.first()).toBeVisible({ timeout: 5_000 })
  await shareBtn.first().click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // Switch to the "Invite link" tab.
  const inviteLinkTab = dialog.getByRole("button", { name: /Invite link/i })
  await expect(inviteLinkTab).toBeVisible({ timeout: 3_000 })
  await inviteLinkTab.click()

  // The recipient email input is visible.
  const emailInput = dialog.locator("#invite-email")
  await expect(emailInput).toBeVisible({ timeout: 3_000 })

  // Type an invalid email.
  await emailInput.fill("not-an-email")

  // Click "Create link".
  const createLinkBtn = dialog.getByRole("button", { name: /Create link/i })
  await expect(createLinkBtn).toBeVisible({ timeout: 2_000 })
  await createLinkBtn.click()

  // Error message appears.
  await expect(
    dialog.getByText(/Enter a valid email address, or leave blank for an open link/i)
  ).toBeVisible({ timeout: 3_000 })
})
