import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Workspace status bar (StatusBar.tsx + DecayBreakdown).
 *
 * The editor footer renders:
 *   - A HealthRing (with a DecayBreakdown popover parent)
 *   - Cell count text: "N cells · N translated (N%)"
 *   - Unvalidated / validated pill counts (when non-zero)
 *
 * This spec: import a file, open the editor, verify the cell count text
 * is present in the footer.
 */
test("workspace status bar shows cell count after importing a file", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `StatusBar ${Date.now()}` })
  await openSeededProject(alice, seeded)

  // Status bar footer shows "N cells · …"
  const footer = alice.locator("footer")
  await expect(footer).toBeVisible({ timeout: 5_000 })
  await expect(footer.getByText(/cells/i).first()).toBeVisible({ timeout: 5_000 })
})
