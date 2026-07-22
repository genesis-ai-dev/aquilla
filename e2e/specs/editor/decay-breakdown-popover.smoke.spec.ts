import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * DecayBreakdown popover in the editor status bar.
 *
 * StatusBar renders a HealthRing wrapped by a DecayBreakdown. Hovering
 * the HealthRing (PopoverTrigger openOnHover delay=300ms) opens a Popover
 * showing:
 *   - The health percentage value (tabular-nums font)
 *   - "% of cells need attention" text
 *   - "No cells need attention." OR a list of dragging cells
 *
 * The HealthRing lives in the editor footer (StatusBar.tsx). NOTE: at
 * health 0 (a fresh project with nothing validated) HealthRing renders NO
 * <svg> — `showRing = health > 0` — only the numeric value inside the
 * trigger. So we hover the DecayBreakdown trigger (the footer's only
 * button, exposed by Base UI's PopoverTrigger) rather than an svg.
 */
test("hovering health ring in status bar opens DecayBreakdown popover", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `Decay ${Date.now()}` })
  await openSeededProject(alice, seeded)

  // The status bar / footer contains the HealthRing inside a <footer>.
  const footer = alice.locator("footer").last()
  await expect(footer).toBeVisible({ timeout: 5_000 })

  // Hover the DecayBreakdown trigger to open the popover (openOnHover
  // delay=300ms). At health 0 there is no svg ring — target the trigger
  // button that wraps the HealthRing value.
  const healthRing = footer.getByRole("button").first()
  await expect(healthRing).toBeVisible({ timeout: 5_000 })
  await healthRing.hover()
  // Allow the 300ms hover delay to fire.
  await alice.waitForTimeout(500)

  // DecayBreakdown popover content: "% of cells need attention" text.
  await expect(
    alice.getByText(/cells need attention/i).first()
      .or(alice.getByText(/No cells need attention/i).first())
  ).toBeVisible({ timeout: 5_000 })
})
