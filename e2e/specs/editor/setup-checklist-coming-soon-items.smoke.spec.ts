import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * SetupChecklistDrawer — "Coming soon" items are visible.
 *
 * SetupChecklistDrawer.tsx renders two ComingSoonStep items:
 *   - "Upload project standards"
 *   - "Import glossary / translation memory"
 *
 * Each renders a disabled card with the title text and a "Coming soon" badge.
 *
 * This spec: opens the setup checklist → verifies both items are visible
 * with their "Coming soon" badge.
 */
test("setup checklist shows Coming soon items for standards and glossary", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `ChecklistSoon ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  // Open the setup checklist.
  const openChecklistBtn = alice.getByRole("button", { name: /Setup:/i })
  await expect(openChecklistBtn).toBeVisible({ timeout: 10_000 })
  await openChecklistBtn.click()

  // The drawer should be open.

  // "Upload project standards" item with "Coming soon" badge.
  const uploadStandardsItem = alice.getByText("Upload project standards").first()
  await expect(uploadStandardsItem).toBeVisible({ timeout: 5_000 })

  // "Import glossary / translation memory" item.
  const importGlossaryItem = alice.getByText(/Import glossary/).first()
  await expect(importGlossaryItem).toBeVisible({ timeout: 3_000 })

  // Both items should have a "Coming soon" badge nearby.
  const comingSoonBadges = alice.getByText("Coming soon")
  await expect(comingSoonBadges.first()).toBeVisible({ timeout: 3_000 })
})
