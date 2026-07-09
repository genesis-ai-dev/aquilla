import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * PendingInvitesSection — create an invite link then revoke it from /members.
 *
 * MembersPage.tsx renders <PendingInvitesSection> which shows pending org
 * invites (those not yet redeemed). Each row has an aria-label="Revoke
 * invitation to <projectName>" trash icon button. Clicking it optimistically
 * removes the row.
 *
 * Flow:
 *   1. Alice creates a project and opens the Share panel.
 *   2. She creates an invite link on the "Invite link" tab.
 *   3. She navigates to /members.
 *   4. The PendingInvitesSection shows the pending invite row.
 *   5. She clicks "Revoke invitation to <name>".
 *   6. The row disappears (optimistic removal).
 */
test("pending invite appears on /members and can be revoked", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `RevokeInvite ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  // Import a file (needed to get into project context for the Share button).
  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Open Share panel → Invite link tab → Create invite link.
  // Share lives in the sidebar "More" menu (sidebar cleanup).
  await alice.getByRole("button", { name: /More project options/i }).click()
  const shareBtn = alice.getByRole("button", { name: /^Share$/i })
  await shareBtn.click()
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await dialog.getByRole("button", { name: /^Invite link$/i }).click()
  const createBtn = dialog.getByRole("button", { name: /Create invite link/i })
  await expect(createBtn).toBeEnabled({ timeout: 5_000 })
  await createBtn.click()
  // Wait for link creation to complete.
  await expect(
    dialog.getByRole("button", { name: /Copy/i })
      .or(dialog.getByText(/\/join\//i).first())
  ).toBeVisible({ timeout: 10_000 })
  await alice.keyboard.press("Escape")

  // Navigate to /members.
  await alice.goto("/members")
  await alice.waitForLoadState("networkidle")

  // The PendingInvitesSection should show the invite row for our project.
  const revokeBtn = alice.getByRole("button", {
    name: new RegExp(`Revoke invitation to ${name}`, "i"),
  })
  await expect(revokeBtn).toBeVisible({ timeout: 10_000 })

  // Since no email was provided, the "Open link" badge should be visible.
  const inviteRow = alice.locator("li").filter({ hasText: name }).first()
  await expect(inviteRow.getByText(/open link/i)).toBeVisible({ timeout: 3_000 })

  // Click revoke — row disappears optimistically.
  await revokeBtn.click()
  await expect(revokeBtn).not.toBeVisible({ timeout: 5_000 })
})
