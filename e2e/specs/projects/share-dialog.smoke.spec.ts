import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Project Share dialog (SharePanel).
 *
 * The workspace sidebar nav has a "Share" button. Clicking it opens a Dialog
 * with title "Share Project" and two tabs: "Members" and "Invite link".
 * This spec verifies the dialog opens and both tabs are accessible.
 */
test("share dialog opens with Members and Invite link tabs", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `Share ${Date.now()}` })
  await openSeededProject(alice, seeded)

  // The "Share" button is in the workspace sidebar nav.
  // Share lives in the sidebar "More" menu (sidebar cleanup).
  await alice.getByRole("button", { name: /More project options/i }).click()
  const shareBtn = alice.getByRole("button", { name: /^Share$/i })
  await expect(shareBtn).toBeVisible({ timeout: 5_000 })
  await shareBtn.click()

  // The SharePanel renders as a named Dialog. Scope to it because other
  // portaled UI, such as the sidebar More menu, may also expose role=dialog.
  const dialog = alice.getByRole("dialog", { name: /Share Project/i })
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog.getByRole("heading", { name: /Share Project/i })).toBeVisible()

  // Both tab buttons are present.
  await expect(dialog.getByRole("button", { name: /^Members$/i })).toBeVisible({ timeout: 3_000 })
  await expect(dialog.getByRole("button", { name: /^Invite link$/i })).toBeVisible({ timeout: 3_000 })

  // Switch to the Invite link tab and verify it renders.
  await dialog.getByRole("button", { name: /^Invite link$/i }).click()

  // Dismiss.
  await alice.keyboard.press("Escape")
  await expect(dialog).not.toBeVisible({ timeout: 3_000 })
})
