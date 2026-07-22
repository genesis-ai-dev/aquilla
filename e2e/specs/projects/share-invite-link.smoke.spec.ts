import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Share panel — Invite link tab.
 *
 * The Invite link tab (InviteLinkTab) has:
 *   - "Create invite link" button
 *   - Optional recipient email input (#invite-email)
 *   - Role selector and expiry options
 *
 * After clicking "Create invite link", the link is generated and a
 * copy button appears.
 *
 * This spec verifies the Invite link tab renders the create form and
 * creates a link.
 */
test("share panel invite link tab creates a link", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `InviteLink ${Date.now()}` })
  await openSeededProject(alice, seeded)

  // Open Share panel.
  // Share lives in the sidebar "More" menu (sidebar cleanup).
  await alice.getByRole("button", { name: /More project options/i }).click()
  const shareBtn = alice.getByRole("button", { name: /^Share$/i })
  await shareBtn.click()
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // Switch to Invite link tab.
  await dialog.getByRole("button", { name: /^Invite link$/i }).click()

  // "Create invite link" button is visible.
  const createBtn = dialog.getByRole("button", { name: /Create invite link/i })
  await expect(createBtn).toBeVisible({ timeout: 3_000 })
  await expect(createBtn).toBeEnabled()

  // Optional email input is present.
  await expect(dialog.locator("#invite-email")).toBeVisible({ timeout: 3_000 })

  // Create the link.
  await createBtn.click()

  // After creation a copy button or link URL appears.
  // The link was created — either a "Copy" button or the URL text appears.
  await expect(
    dialog.getByRole("button", { name: /Copy/i })
      .or(dialog.getByText(/\/join\//i).first())
  ).toBeVisible({ timeout: 10_000 })

  // Dismiss.
  await alice.keyboard.press("Escape")
})
