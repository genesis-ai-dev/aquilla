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
 * button that opens an inline textarea. Fill and click Save → entry appears.
 * Cancel closes the textarea without adding.
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

  // Click Add — inline textarea appears.
  await standardsSection.getByRole("button", { name: /Add/i }).click()
  const textarea = standardsSection.locator("textarea").first()
  await expect(textarea).toBeVisible({ timeout: 3_000 })

  // Cancel closes the textarea.
  await standardsSection.getByRole("button", { name: /Cancel/i }).click()
  await expect(textarea).not.toBeVisible({ timeout: 2_000 })

  // Re-open, fill, and save.
  await standardsSection.getByRole("button", { name: /Add/i }).click()
  const textarea2 = standardsSection.locator("textarea").first()
  await expect(textarea2).toBeVisible({ timeout: 3_000 })
  const entryText = `Standard rule ${Date.now()}`
  await textarea2.fill(entryText)
  await standardsSection.getByRole("button", { name: /Save/i }).click()

  // Entry appears in the section.
  await expect(standardsSection.getByText(entryText).first()).toBeVisible({ timeout: 5_000 })
})
