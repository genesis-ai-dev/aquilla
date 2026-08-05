import { test, expect } from "../../helpers/multi-user"
import { ensureAuthState } from "../../helpers/auth"
import { createProjectServerSide, createProjectInvite } from "../../helpers/frontier-api"

/**
 * Join page (/join/:token) — error state for an invalid token.
 *
 * JoinPage.tsx:
 *   - When the user is authenticated and the token is invalid/expired,
 *     redeem() fails and sets phase = "error" with an error message.
 *   - The card header shows "Joining Project".
 *   - An AlertCircle + error text appears.
 *   - "Back to projects" returns the signed-in user to their scoped org home.
 *
 * We can test this with a bogus token — the API will reject it and we'll
 * see the error state without needing a real invite.
 */
test("join page with invalid token shows error state and Back to projects", async ({ alice }) => {
  await alice.goto("/join/invalid-token-e2e-test")

  // Card header shows "Joining Project".
  await expect(alice.getByText(/Joining Project/i).first()).toBeVisible({ timeout: 10_000 })

  // Error state appears after the API rejects the token.
  await expect(
    alice.getByRole("button", { name: /Back to projects/i })
  ).toBeVisible({ timeout: 10_000 })

  // "Back to projects" navigates through RootRedirect to the user's scoped
  // organization home. Assert the durable destination, not the transient "/"
  // route that immediately redirects and may never be observable.
  await alice.getByRole("button", { name: /Back to projects/i }).click()
  await expect(alice).toHaveURL(/\/orgs\/[^/?]+$/, { timeout: 10_000 })
  await expect(alice.getByRole("heading", { name: "Acme", exact: true })).toBeVisible()
})

/**
 * AQU-471 — the join page must answer "who invited me, to what?" (Biblica
 * pilot feedback). A real invite minted by alice must show her name and the
 * workspace on bob's landing page, not just the project name.
 */
test("join page names the inviter and workspace on a real invite", async ({ bob }) => {
  const aliceSession = await ensureAuthState("alice")
  const proj = await createProjectServerSide(aliceSession.jwt, {
    id: `join-ctx-${Date.now()}`,
    name: `JoinCtx ${Date.now()}`,
  })
  const invite = await createProjectInvite(aliceSession.jwt, proj.id)

  await bob.goto(`/join/${invite.token}`)
  await expect(bob.getByText(proj.name)).toBeVisible({ timeout: 10_000 })
  await expect(bob.getByText(/Invited by/i)).toBeVisible()
  await expect(bob.getByText("alice", { exact: true })).toBeVisible()
  await expect(bob.getByRole("button", { name: /Accept invitation/i })).toBeVisible()
})
