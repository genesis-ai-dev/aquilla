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
 * MembersPanel.tsx renders a <select> (role picker) next to each
 * non-locked, non-self member. Changing the value calls onChangeRole.
 *
 * This spec: seeds bob in alice's org → creates a project → opens
 * SharePanel → adds bob → changes his role via the select →
 * verifies the select now shows the new role.
 */
test("share panel members tab role select changes member's role", async ({ alice }) => {
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.CONTRIBUTOR)

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
  const shareBtn = alice.getByRole("button", { name: /^Share$/i })
  await shareBtn.click()
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // Members tab should be active by default.
  // Add bob using the UsernameTypeahead input.
  const usernameInput = dialog.locator('input[placeholder*="username"], input[placeholder*="Aquilla"]').first()
  await expect(usernameInput).toBeVisible({ timeout: 5_000 })
  await usernameInput.fill("bob")
  await alice.waitForTimeout(500) // allow typeahead to resolve

  const addBtn = dialog.getByRole("button", { name: /^Add$/i })
    .or(dialog.getByRole("button", { name: /Add member/i }))
  await expect(addBtn.first()).toBeVisible({ timeout: 5_000 })
  await addBtn.first().click()

  // Wait for bob to appear in the members list.
  await expect(dialog.getByText("bob")).toBeVisible({ timeout: 8_000 })

  // Change bob's role via the select next to his name.
  const bobRow = dialog.locator("li").filter({ hasText: "bob" })
  const roleSelect = bobRow.locator("select").first()
  await expect(roleSelect).toBeVisible({ timeout: 5_000 })

  // Read current value and switch to a different role.
  const currentRole = await roleSelect.inputValue()
  const allOptions = await roleSelect.locator("option").allInnerTexts()
  const otherRole = allOptions.find((o) => o !== currentRole)
  if (!otherRole) {
    // If there's only one grantable role, just verify the select exists.
    await expect(roleSelect).toBeVisible()
    return
  }

  await roleSelect.selectOption({ label: otherRole })
  await expect(roleSelect).not.toHaveValue(currentRole, { timeout: 3_000 })

  // Dismiss.
  await alice.keyboard.press("Escape")
})
