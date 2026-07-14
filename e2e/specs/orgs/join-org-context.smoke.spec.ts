import { test, expect } from "../../helpers/multi-user"
import { ensureAuthState } from "../../helpers/auth"
import { getMyOrg, createOrgInvite } from "../../helpers/frontier-api"

/**
 * AQU-471 — org-invite landing page (/join-org/:token) context.
 *
 * The exact Biblica pilot complaint: "please mention the WORKSPACE / ORG that
 * I was invited to". The page used to render a fully generic "You've been
 * invited to join an organization on Aquilla." It must now name the org, the
 * inviter, and the role (public preview endpoint), and accepting must land
 * the recipient in the org.
 */
test("join-org page names the org and inviter, and accept joins it", async ({ bob }) => {
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)
  const invite = await createOrgInvite(aliceSession.jwt, acme.id)

  await bob.goto(`/join-org/${invite.token}`)

  // Context card: org name (also in the title), inviter, role.
  await expect(bob.getByText(`Join ${acme.name}`)).toBeVisible({ timeout: 10_000 })
  await expect(bob.getByText(/Invited by/i)).toBeVisible()
  await expect(bob.getByText("alice", { exact: true })).toBeVisible()

  // Accept → success state names the org again.
  await bob.getByRole("button", { name: /Accept invitation/i }).click()
  await expect(bob.getByText(/You're in/i)).toBeVisible({ timeout: 10_000 })
  await expect(bob.getByText(new RegExp(`Joined ${acme.name}`))).toBeVisible()
})
