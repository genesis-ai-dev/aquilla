import { test, expect } from "../../helpers/multi-user"
import { expectSelectValue, pickSelectOption } from "../../helpers/base-ui"

/**
 * TeamsList (/teams) — search filter and sort select.
 *
 * TeamsList.tsx renders (when teams exist):
 *   - input type="search" placeholder="Search teams…"
 *   - Base UI Select aria-label="Sort teams by" with options: Name (A–Z),
 *     Members (most first), Projects (most first)
 *
 * This spec: creates a team → navigates to /teams → verifies the search
 * input is visible → types a non-matching query → verifies "No teams match"
 → clears → team is visible again → changes sort to "Members".
 */
test("teams list filter and sort controls work", async ({ alice }) => {
  // Create a team so the search/sort controls appear.
  await alice.goto("/teams")
  await alice.waitForLoadState("networkidle")

  const createBtn = alice.getByRole("button", { name: /New team|Create team/i })
  await expect(createBtn).toBeVisible({ timeout: 10_000 })
  await createBtn.click()

  const teamName = `SortFilter ${Date.now()}`
  const nameInput = alice.locator('input[type="text"], input:not([type])').first()
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  await nameInput.fill(teamName)
  await alice.getByRole("button", { name: /Create|Save/i }).first().click()

  // Creating a team navigates straight to its detail page (/teams/:id);
  // return to the list where the search/sort controls live.
  await alice.waitForURL(/\/teams\/\d+/, { timeout: 10_000 })
  await alice.goto("/teams")
  await alice.waitForLoadState("networkidle")

  // Team appears in the list.
  await expect(alice.getByText(teamName)).toBeVisible({ timeout: 8_000 })

  // Search filter input appears.
  const searchInput = alice.locator('input[type="search"], input[placeholder*="Search teams"]')
  await expect(searchInput).toBeVisible({ timeout: 5_000 })

  // Type a non-matching query.
  await searchInput.fill("zzznomatch")
  await expect(alice.getByText(/No teams match/i)).toBeVisible({ timeout: 3_000 })

  // Clear the query — team reappears.
  await searchInput.fill("")
  await expect(alice.getByText(teamName)).toBeVisible({ timeout: 3_000 })

  // Change sort to "Members (most first)".
  const sortSelect = alice.getByRole("combobox", { name: "Sort teams by" })
  await expect(sortSelect).toBeVisible({ timeout: 3_000 })
  await pickSelectOption(alice, sortSelect, "Members (most first)")
  await expectSelectValue(sortSelect, "Members (most first)")

  // Restore sort.
  await pickSelectOption(alice, sortSelect, "Name (A–Z)")
  await expectSelectValue(sortSelect, "Name (A–Z)")
})
