import { test, expect, orgRoute } from "../../helpers/multi-user"

/**
 * TeamsList (/teams) — search filter and column sort.
 *
 * TeamsList.tsx renders (when teams exist) an admin-style DataTable with:
 *   - search placeholder "Search teams…"
 *   - sortable Team / Members / Projects column headers
 *   - All / Internal only / Public only visibility select
 *
 * This spec: creates a team → navigates to /teams → verifies search →
 * types a non-matching query → verifies "No teams match" → clears →
 * team is visible again → sorts by Members via the column header.
 */
test("teams list filter and sort controls work", async ({ alice }) => {
  // Create a team so the search/sort controls appear.
  await alice.goto(orgRoute(alice, "/teams"))
  const createBtn = alice.getByRole("button", { name: /New team|Create team/i })
  await expect(createBtn).toBeVisible({ timeout: 10_000 })
  await createBtn.click()

  const teamName = `SortFilter ${Date.now()}`
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 3_000 })
  const nameInput = dialog.getByLabel(/^Team name$/i)
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  await nameInput.fill(teamName)
  await dialog.getByRole("button", { name: /^Create$/i }).click()

  // Creating a team navigates straight to its detail page (/teams/:id);
  // return to the list where the search/sort controls live.
  await alice.waitForURL(/\/teams\/\d+/, { timeout: 10_000 })
  await alice.goto(orgRoute(alice, "/teams"))
  // Team appears in the list.
  await expect(alice.getByText(teamName)).toBeVisible({ timeout: 8_000 })

  // Search filter input appears.
  const searchInput = alice.getByPlaceholder("Search teams…")
  await expect(searchInput).toBeVisible({ timeout: 5_000 })

  // Type a non-matching query.
  await searchInput.fill("zzznomatch")
  await expect(alice.getByText(/No teams match/i)).toBeVisible({ timeout: 3_000 })

  // Clear the query — team reappears.
  await searchInput.fill("")
  await expect(alice.getByText(teamName)).toBeVisible({ timeout: 3_000 })

  // Sort by Members via the column header (unsorted → descending).
  const membersHeader = alice.getByRole("button", { name: /^Members$/i })
  await expect(membersHeader).toBeVisible({ timeout: 3_000 })
  await membersHeader.click()
  await expect(membersHeader).toHaveAttribute("aria-sort", "descending")
})
