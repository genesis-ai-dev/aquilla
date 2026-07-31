import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Living Memory — Standards section.
 *
 * The LivingMemoryPage has three AuthoredSections:
 *   - Instructions (covered by living-memory-add-entry.smoke.spec.ts)
 *   - Standards  ← this spec
 *   - (Recent Examples is read-only, not an authored section)
 *
 * AuthoredSection renders a <section aria-label="Standards"> with an "Add"
 * button that opens a create dialog. Fill and click Save → entry appears.
 * Cancel closes the dialog without adding.
 */
test("living memory standards section add entry shows text and cancel works", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `MemStd ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/memory`)
  const standardsSection = alice.locator('section[aria-label="Standards"]')
  await expect(standardsSection).toBeVisible({ timeout: 10_000 })

  // Click Add — create dialog appears.
  await standardsSection.getByRole("button", { name: /Add/i }).click()
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 3_000 })
  const textarea = dialog.locator("textarea").first()
  await expect(textarea).toBeVisible({ timeout: 3_000 })

  // Cancel closes the dialog.
  await dialog.getByRole("button", { name: /Cancel/i }).click()
  await expect(dialog).not.toBeVisible({ timeout: 2_000 })

  // Re-open, fill, and save.
  await standardsSection.getByRole("button", { name: /Add/i }).click()
  const dialog2 = alice.getByRole("dialog")
  await expect(dialog2).toBeVisible({ timeout: 3_000 })
  const textarea2 = dialog2.locator("textarea").first()
  await expect(textarea2).toBeVisible({ timeout: 3_000 })
  const entryText = `Standard rule ${Date.now()}`
  await textarea2.fill(entryText)
  await dialog2.getByRole("button", { name: /Save/i }).click()
  await expect(dialog2).not.toBeVisible({ timeout: 5_000 })

  // Entry appears in the section.
  await expect(standardsSection.getByText(entryText).first()).toBeVisible({ timeout: 5_000 })
})
