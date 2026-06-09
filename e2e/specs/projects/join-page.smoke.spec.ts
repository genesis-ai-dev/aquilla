import { test, expect } from "../../helpers/multi-user"

/**
 * Join page (/join/:token) — error state for an invalid token.
 *
 * JoinPage.tsx:
 *   - When the user is authenticated and the token is invalid/expired,
 *     redeem() fails and sets phase = "error" with an error message.
 *   - The card header shows "Joining Project".
 *   - An AlertCircle + error text appears.
 *   - "Back to projects" button navigates to /.
 *
 * We can test this with a bogus token — the API will reject it and we'll
 * see the error state without needing a real invite.
 */
test("join page with invalid token shows error state and Back to projects", async ({ alice }) => {
  await alice.goto("/join/invalid-token-e2e-test")
  await alice.waitForLoadState("networkidle")

  // Card header shows "Joining Project".
  await expect(alice.getByText(/Joining Project/i).first()).toBeVisible({ timeout: 10_000 })

  // Error state appears after the API rejects the token.
  await expect(
    alice.getByRole("button", { name: /Back to projects/i })
  ).toBeVisible({ timeout: 10_000 })

  // "Back to projects" navigates home.
  await alice.getByRole("button", { name: /Back to projects/i }).click()
  // "/" redirects to "/projects" via RootRedirect.
  await alice.waitForURL(/^\/(projects)?$/, { timeout: 5_000 })
})
