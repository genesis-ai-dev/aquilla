import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { ProjectSettings } from "../../helpers/page-objects/ProjectSettings"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, createOrg, ROLE } from "../../helpers/frontier-api"

/**
 * Settings → Members — change a member's project role.
 *
 * MembersSection renders a row-actions menu ("Actions for <username>") with a
 * "Change role" submenu. This spec: seeds bob into a separate alice-owned org
 * so scoped search can find him, creates a project, adds bob, then changes
 * his role via the row menu.
 */
test("share panel members tab role select changes member's role", async ({ alice }) => {
  const aliceSession = await ensureAuthState("alice")
  const searchScopeOrg = await createOrg(aliceSession.jwt, `Z Role Change Search Scope ${Date.now()}`)
  await addOrgMember(aliceSession.jwt, searchScopeOrg.id, "bob", ROLE.VIEWER)

  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `RoleChange ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await expect(alice).toHaveURL(/\/projects\/[^/?#]+/, { timeout: 15_000 })

  const settings = new ProjectSettings(alice)
  const dialog = await settings.openAddMemberDialog(settings.projectIdFromCurrentUrl())

  const usernameInput = dialog.locator('input[placeholder*="username"], input[placeholder*="Aquilla"]').first()
  await expect(usernameInput).toBeVisible({ timeout: 5_000 })
  await usernameInput.fill("bob")

  const suggestion = alice.getByRole("checkbox", { name: "bob" })
  await expect(suggestion).toBeVisible({ timeout: 8_000 })
  await suggestion.click()
  await expect(dialog.getByRole("button", { name: "Remove bob" })).toBeVisible({ timeout: 5_000 })
  await dialog.getByRole("heading", { name: /Add a member/i }).click()

  const addBtn = dialog.getByRole("button", { name: /^Add$/i })
  await expect(addBtn).toBeEnabled({ timeout: 5_000 })
  await addBtn.click()
  await expect(dialog).not.toBeVisible({ timeout: 8_000 })

  const table = alice.getByTestId("settings-members-table")
  await expect(table.getByText("bob").first()).toBeVisible({ timeout: 8_000 })

  const bobRow = table.getByRole("row").filter({ hasText: "bob" })
  await bobRow.hover()
  await alice.getByRole("button", { name: /Actions for bob/i }).click()
  await alice.getByRole("menuitem", { name: /Change role/i }).click()

  const reviewerItem = alice.getByRole("menuitem").filter({ hasText: /^reviewer/i }).first()
  await expect(reviewerItem).toBeVisible({ timeout: 5_000 })
  await reviewerItem.click()

  await expect(bobRow.getByText(/reviewer/i).first()).toBeVisible({ timeout: 8_000 })
})
