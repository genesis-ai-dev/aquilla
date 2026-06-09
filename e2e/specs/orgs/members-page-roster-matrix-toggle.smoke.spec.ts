import { test, expect } from "../../helpers/multi-user"

/**
 * MembersPage — Roster / Matrix view toggle.
 *
 * MembersPage.tsx renders a toggle between two views:
 *   - "Roster" button → shows per-member detail
 *   - "Matrix" button → shows member × project matrix
 *
 * The active view has "bg-background shadow-sm" styling.
 *
 * This spec:
 *   1. Navigates to /members.
 *   2. Verifies "Roster" and "Matrix" buttons exist.
 *   3. Clicks "Matrix" → the matrix view renders.
 *   4. Clicks "Roster" → roster view restores.
 */
test("MembersPage Roster/Matrix toggle switches the view", async ({ alice }) => {
  await alice.goto("/members")
  await alice.waitForLoadState("networkidle")

  // Both toggle buttons should be visible.
  const rosterBtn = alice.getByRole("button", { name: /^Roster$/i }).first()
  const matrixBtn = alice.getByRole("button", { name: /^Matrix$/i }).first()

  await expect(rosterBtn).toBeVisible({ timeout: 8_000 })
  await expect(matrixBtn).toBeVisible({ timeout: 5_000 })

  // Click Matrix.
  await matrixBtn.click()
  await alice.waitForTimeout(300)

  // Matrix view should now be shown — members-matrix table appears.
  // The matrix renders a <table> with role="table" or a thead.
  const matrixTable = alice.locator("table, [role='table']").first()
  await expect(matrixTable).toBeVisible({ timeout: 5_000 })

  // Click Roster.
  await rosterBtn.click()
  await alice.waitForTimeout(300)

  // Roster view: matrix table should be gone (or roster row cards appear).
  await expect(matrixTable).not.toBeVisible({ timeout: 3_000 })
})
