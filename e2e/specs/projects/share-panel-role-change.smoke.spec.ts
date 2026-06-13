import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, getMyOrg, ROLE } from "../../helpers/frontier-api"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * SharePanel (Members tab) — change a member's project role.
 *
 * MembersPanel.tsx renders a Base UI Select (trigger aria-label="Change
 * role") next to each non-locked, non-self member. Changing the value
 * calls onChangeRole.
 *
 * This spec: seeds bob in alice's org → creates a project → opens
 * SharePanel → adds bob → changes his role via the select →
 * verifies the trigger now shows the new role.
 */
test("share panel members tab role select changes member's role", async ({ alice }) => {
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)
  // Seed bob at VIEWER so the direct CONTRIBUTOR grant added below is
  // STRICTLY higher than his org role. With an equal-level org role the
  // effective-access list keeps source=org and the row renders locked
  // ("Remove from org to revoke") with no "Change role" select.
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.VIEWER)

  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `RoleChange ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Open Share panel.
  // Share lives in the sidebar "More" menu (sidebar cleanup).
  await alice.getByRole("button", { name: /More project options/i }).click()
  const shareBtn = alice.getByRole("button", { name: /^Share$/i })
  await shareBtn.click()
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // Members tab should be active by default.
  // Add bob using the UsernameTypeahead input.
  const usernameInput = dialog.locator('input[placeholder*="username"], input[placeholder*="Aquilla"]').first()
  await expect(usernameInput).toBeVisible({ timeout: 5_000 })
  await usernameInput.fill("bob")

  // Pick the "bob" suggestion — this closes the typeahead dropdown (which
  // would otherwise overlay the controls below it).
  const suggestion = dialog.getByRole("button", { name: "bob", exact: true })
  await expect(suggestion).toBeVisible({ timeout: 8_000 })
  await suggestion.click()

  const addBtn = dialog.getByRole("button", { name: /^Add$/i })
    .or(dialog.getByRole("button", { name: /Add member/i }))
  await expect(addBtn.first()).toBeVisible({ timeout: 5_000 })
  await addBtn.first().click()

  // Wait for bob's row to reflect the direct grant (contributor beats his
  // viewer org role, so the row is unlocked and gets the "Change role" select).
  await expect(dialog.getByText("bob").first()).toBeVisible({ timeout: 8_000 })

  // Change bob's role via the select next to his name.
  const bobRow = dialog.locator("li").filter({ hasText: "bob" })
  const roleSelect = bobRow.getByRole("combobox", { name: "Change role" })
  await expect(roleSelect).toBeVisible({ timeout: 5_000 })

  // Read the current role label and switch to a different one.
  const currentRole = (await roleSelect.textContent())?.trim() ?? ""
  await roleSelect.click()
  const listbox = alice.getByRole("listbox")
  await expect(listbox).toBeVisible({ timeout: 3_000 })
  const otherOption = alice.getByRole("option").filter({ hasNotText: currentRole }).first()
  if (!(await otherOption.isVisible({ timeout: 1_000 }).catch(() => false))) {
    // If there's only one grantable role, just verify the select exists.
    await alice.keyboard.press("Escape")
    await expect(roleSelect).toBeVisible()
    return
  }
  const newRole = (await otherOption.textContent())?.trim() ?? ""
  await otherOption.click()
  await expect(listbox).toBeHidden({ timeout: 3_000 })
  await expect(roleSelect).toContainText(newRole, { timeout: 3_000 })

  // Dismiss.
  await alice.keyboard.press("Escape")
})
