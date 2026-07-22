import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * SetupChecklistDrawer — ChecklistItem expand/collapse.
 *
 * Each checklist item in SetupChecklistDrawer renders via ChecklistItem.tsx,
 * which has an `aria-expanded` button that toggles the detail panel.
 *
 * This spec: open the setup checklist → verify a checklist item exists →
 * click it to expand (aria-expanded="true") → click again to collapse.
 */
test("setup checklist item expands and collapses on click", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `ChecklistExpand ${Date.now()}` })
  await openSeededProject(alice, seeded)

  // Open the setup checklist chip.
  const chip = alice.getByRole("button", { name: /Setup:/i })
  await expect(chip).toBeVisible({ timeout: 10_000 })
  await chip.click()

  // Drawer opens with "Project setup" heading.
  await expect(alice.getByRole("heading", { name: /Project setup/i })).toBeVisible({
    timeout: 5_000,
  })

  // Find the first checklist item button (aria-expanded) INSIDE the drawer.
  // Scope to the sheet dialog: the sidebar's "More project options" popover
  // trigger also carries aria-expanded and sits behind the sheet overlay,
  // so an unscoped .first() grabs it and the click is intercepted forever.
  // The first item is "Import files" — complete after importFile() above, so
  // it starts collapsed (ChecklistItem opens incomplete items by default).
  const drawer = alice.getByRole("dialog", { name: /Project setup/i })
  const itemBtn = drawer.locator('button[aria-expanded]').first()
  await expect(itemBtn).toBeVisible({ timeout: 5_000 })
  await expect(itemBtn).toHaveAttribute("aria-expanded", "false")

  // Click to expand.
  await itemBtn.click()
  await expect(itemBtn).toHaveAttribute("aria-expanded", "true", { timeout: 2_000 })

  // Click again to collapse.
  await itemBtn.click()
  await expect(itemBtn).toHaveAttribute("aria-expanded", "false", { timeout: 2_000 })

  // Close drawer.
  await alice.keyboard.press("Escape")
})
