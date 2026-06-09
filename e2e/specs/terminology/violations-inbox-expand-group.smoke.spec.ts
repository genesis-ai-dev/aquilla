import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * TerminologyViolationsInbox — expand concept group row.
 *
 * TerminologyViolationsInbox renders one collapsible row per concept that has
 * violations. The group button has aria-expanded (false by default). Clicking
 * it toggles the infraction list open.
 *
 * Setup to produce a real violation:
 *   1. Import sample.md (cells have original text containing "sample").
 *   2. Create a concept with sourceTerm="sample" and a FORBIDDEN rendering
 *      matching what alice actually typed (or just leaving cells untranslated
 *      so "missing approved" violations appear).
 *   Actually the simplest path: create a concept with sourceTerm="sample"
 *   and a preferred rendering. Since cells are untranslated, they produce
 *   "missing approved rendering" violations — count > 0, group appears.
 *
 * Then:
 *   3. Navigate to Violations tab.
 *   4. Verify the concept group row appears (aria-expanded=false).
 *   5. Click it → aria-expanded=true, infraction list appears.
 */
test("violations inbox concept group expands to show infraction list", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `ViolExpand ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)

  // Navigate to Terminology page.
  const projectId = alice.url().match(/\/project\/([^/]+)/)?.[1]
  expect(projectId).toBeTruthy()
  await alice.goto(`/project/${projectId}/terminology`)
  await alice.waitForLoadState("networkidle")

  // Create a concept with sourceTerm="sample" and a preferred rendering.
  // This creates an "approved rendering" requirement — cells with
  // original="sample" that don't use the approved rendering trigger violations.
  const newConceptBtn = alice.getByRole("button", { name: /new concept|add concept|\+ concept/i }).first()
  await expect(newConceptBtn).toBeVisible({ timeout: 8_000 })
  await newConceptBtn.click()

  const sourceTermInput = alice.locator('input[placeholder*="source" i], input[aria-label*="source" i]').first()
  await expect(sourceTermInput).toBeVisible({ timeout: 5_000 })
  await sourceTermInput.fill("sample")
  await sourceTermInput.press("Enter")

  // Add a preferred rendering to enforce (so absence = violation).
  const addRenderingBtn = alice.getByRole("button", { name: /add rendering|preferred rendering|\+ rendering/i }).first()
  if (await addRenderingBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await addRenderingBtn.click()
    const renderingInput = alice.locator('input[aria-label*="rendering" i], input[placeholder*="rendering" i]').first()
    if (await renderingInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await renderingInput.fill("échantillon")
      await renderingInput.press("Enter")
    }
  }

  // Allow concept to compile + violations to compute.
  await alice.waitForTimeout(1_500)

  // Navigate to Violations tab.
  const violationsTab = alice.getByRole("button", { name: /^Violations$/i })
  await expect(violationsTab).toBeVisible({ timeout: 10_000 })
  await violationsTab.click()

  // A concept group row should appear for "sample" (violations > 0).
  // The group button has aria-expanded attribute.
  const groupBtn = alice.locator('button[aria-expanded]').filter({ hasText: /sample/i }).first()
  await expect(groupBtn).toBeVisible({ timeout: 10_000 })

  // Verify initially collapsed.
  await expect(groupBtn).toHaveAttribute("aria-expanded", "false")

  // Click to expand.
  await groupBtn.click()
  await expect(groupBtn).toHaveAttribute("aria-expanded", "true", { timeout: 3_000 })

  // Infraction list should now be visible (ul.mt-2 with li items).
  const infractions = alice.locator("ul.mt-2 li").first()
  await expect(infractions).toBeVisible({ timeout: 3_000 })
})
