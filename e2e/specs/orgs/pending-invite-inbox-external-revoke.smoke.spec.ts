import { test, expect, orgRoute } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * AQU-326 — both halves of membership visibility:
 *
 * A. Received invites: an email-targeted invite must be discoverable on the
 *    invitee's dashboard ("Pending invitations" card → /join/:token
 *    confirmation), because the invite email/link may never have arrived.
 * B. External collaborators: once the invitee accepts, the org's Members
 *    page must show them as an external (non-org-member with a project
 *    grant) and let an org maintainer revoke that grant in place.
 *
 * Seeds: alice is an org maintainer in the dev org; bob is NOT an org
 * member (he reaches Exodus only via the Reviewers group), so bob is the
 * external. bob's e2e account email is bob@example.test (e2e/helpers/seed.ts).
 */
test("targeted invite surfaces in bob's inbox; after accept, alice sees and revokes the external grant", async ({ alice, bob }) => {
  test.setTimeout(30_000)

  // ── alice: create a project + email-targeted invite for bob ──
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `ExtInvite ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  await alice.getByRole("button", { name: /More project options/i }).click()
  await alice.getByRole("button", { name: /^Share$/i }).click()
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await dialog.getByRole("button", { name: /^Invite link$/i }).click()
  await dialog.locator("#invite-email").fill("bob@example.test")
  await dialog.getByRole("button", { name: /Create invite link/i }).click()
  await expect(dialog.locator("input[readonly]")).toBeVisible({ timeout: 10_000 })
  await alice.keyboard.press("Escape")

  // ── bob: the invite is discoverable from the dashboard, no link needed ──
  await bob.goto("/")
  const inbox = bob.getByTestId("pending-invitations")
  await expect(inbox).toBeVisible({ timeout: 10_000 })
  await expect(inbox.getByText(name)).toBeVisible()
  await inbox.getByRole("link", { name: /Review & accept/i }).click()

  // JoinPage confirmation (AQU-335) → explicit accept → workspace.
  await bob.getByRole("button", { name: /Accept invitation/i }).click({ timeout: 10_000 })
  await bob.waitForURL(/\/project\//, { timeout: 15_000 })

  // ── alice: bob now appears as an external collaborator, revocable ──
  await alice.goto(orgRoute(alice, "/members"))
  const section = alice.getByTestId("external-collaborators")
  await expect(section).toBeVisible({ timeout: 10_000 })
  const bobRow = section.locator("li").filter({ hasText: "bob" })
  await expect(bobRow).toBeVisible()
  await expect(bobRow.getByText(name)).toBeVisible()

  await bobRow
    .getByRole("button", { name: new RegExp(`Revoke bob's access to ${name}`, "i") })
    .click()

  // The grant chip disappears (bob may remain listed via his seeded group
  // grant on Exodus — we assert the revoked project, not the whole row).
  await expect(section.getByText(name)).toBeHidden({ timeout: 10_000 })

  // ── bob: the revoked project is gone from his dashboard too ──
  await bob.goto("/projects")
  await bob.waitForLoadState("networkidle")
  await expect(bob.getByText(name)).toBeHidden({ timeout: 10_000 })
})
