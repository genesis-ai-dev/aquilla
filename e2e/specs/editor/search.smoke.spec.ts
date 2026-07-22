import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Search panel (ParallelPassagesPanel in "search" mode).
 *
 * Tests:
 *  1. The panel opens via the dock rail Search tab → "Open full search panel".
 *     (AQU-308 replaced the old toolbar "Search & replace" button with a
 *     Search tab in the left dock; the full ParallelPassagesPanel dialog now
 *     opens from the dock panel's "Open full search panel" button or ⌘F.)
 *  2. The search input accepts text and returns "No results" for a garbage query.
 *  3. The panel can be dismissed with Escape.
 *
 * The search index is built lazily after the panel opens; an unmatched query
 * should reliably surface "No results for …" once the index is ready.
 */
test("search panel opens, accepts a query, and shows no-results for unmatched text", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `Search ${Date.now()}` })
  await openSeededProject(alice, seeded)

  // 1. Open the dock Search tab, then the full search panel dialog.
  await alice.getByRole("button", { name: "Search", exact: true }).click()
  const openFullBtn = alice.getByRole("button", { name: "Open full search panel" })
  await expect(openFullBtn).toBeVisible({ timeout: 5_000 })
  await openFullBtn.click()

  // The panel is rendered as a Dialog.
  const panel = alice.getByRole("dialog")
  await expect(panel).toBeVisible({ timeout: 5_000 })

  // 2. The command input exposes a combobox role.
  const input = panel.getByRole("combobox").first()
  await expect(input).toBeVisible({ timeout: 5_000 })

  // Type a query that definitely won't match any cell content.
  const needle = `zzz-no-match-${Date.now()}`
  await input.fill(needle)

  // The panel shows "No results for …" once the index is built and the query returns nothing.
  await expect(panel.getByText(/No results for/i)).toBeVisible({ timeout: 10_000 })

  // 3. Dismiss with Escape.
  await alice.keyboard.press("Escape")
  await expect(panel).not.toBeVisible({ timeout: 5_000 })
})
