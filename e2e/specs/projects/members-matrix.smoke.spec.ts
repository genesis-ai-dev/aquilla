import { test, expect } from "../../helpers/multi-user"

/**
 * Members page (/members) — Roster and Matrix view toggle.
 *
 * MembersPage.tsx renders:
 *   - h1 "Members"
 *   - View toggle: "Roster" (default) and "Matrix" buttons
 *   - Switching to Matrix renders MembersMatrixView
 *
 * This spec verifies the route loads and the view toggle works.
 */
test("members page renders and Matrix view toggle works", async ({ alice }) => {
  await alice.goto("/members")
  await alice.waitForLoadState("networkidle")

  await expect(alice.locator("h1").filter({ hasText: /Members/i }).first()).toBeVisible({
    timeout: 10_000,
  })

  // View toggle buttons are present.
  const matrixBtn = alice.getByRole("button", { name: /Matrix/i })
  await expect(alice.getByRole("button", { name: /Roster/i })).toBeVisible({ timeout: 5_000 })
  await expect(matrixBtn).toBeVisible({ timeout: 5_000 })

  // Switch to Matrix view.
  await matrixBtn.click()
  await alice.waitForLoadState("networkidle")

  // Heading still visible (no navigation occurred).
  await expect(alice.locator("h1").filter({ hasText: /Members/i }).first()).toBeVisible({
    timeout: 3_000,
  })
})
