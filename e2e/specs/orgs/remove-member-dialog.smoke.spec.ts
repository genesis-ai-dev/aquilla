import { test, expect } from "../../helpers/multi-user"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, getMyOrg, ROLE } from "../../helpers/frontier-api"

/**
 * RemoveOrgMemberDialog — remove a member from the org.
 *
 * Requires bob to be a member of Acme. We add him via the API, then
 * alice navigates to /members and clicks his "Remove bob" button.
 * RemoveOrgMemberDialog opens with title "Remove bob from Acme?".
 *
 * This spec verifies the dialog opens and Cancel dismisses without removing.
 */
test("remove member dialog opens and Cancel keeps member", async ({ alice }) => {
  // Add bob to Acme via API so he appears in the roster.
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.CONTRIBUTOR)

  await alice.goto("/members")
  await alice.waitForLoadState("networkidle")

  // Wait for bob to appear in the members list.
  await expect(alice.getByText("bob").first()).toBeVisible({ timeout: 10_000 })

  // Click "Remove bob" button.
  const removeBtn = alice.getByRole("button", { name: /Remove bob/i })
  await expect(removeBtn).toBeVisible({ timeout: 5_000 })
  await removeBtn.click()

  // RemoveOrgMemberDialog opens.
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(
    dialog.getByRole("heading", { name: /Remove bob from/i })
  ).toBeVisible()

  // Cancel closes without removing.
  await dialog.getByRole("button", { name: /Cancel/i }).click()
  await expect(dialog).not.toBeVisible({ timeout: 3_000 })

  // Bob is still in the members list.
  await expect(alice.getByText("bob").first()).toBeVisible({ timeout: 3_000 })
})
