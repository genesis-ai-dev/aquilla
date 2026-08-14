import { test, expect, orgRoute } from "../../helpers/multi-user"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, getMyOrg, ROLE } from "../../helpers/frontier-api"

/**
 * RemoveOrgMemberDialog — remove a member from the org.
 *
 * Requires bob to be a member of Acme. We add him via the API, then
 * alice navigates to /members, opens his row-actions menu, and chooses
 * "Remove from org". RemoveOrgMemberDialog opens with title
 * "Remove bob from Acme?".
 *
 * This spec verifies the dialog opens and Cancel dismisses without removing.
 */
test("remove member dialog opens and Cancel keeps member", async ({ alice }) => {
  // Add bob to Acme via API so he appears in the roster.
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.CONTRIBUTOR)

  await alice.goto(orgRoute(alice, "/members"))
  await expect(alice.getByText("bob").first()).toBeVisible({ timeout: 10_000 })

  const actionsBtn = alice.getByRole("button", { name: /Actions for bob/i })
  await expect(actionsBtn).toBeVisible({ timeout: 5_000 })
  await actionsBtn.click()
  await alice.getByRole("menuitem", { name: /Remove bob/i }).click()

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
