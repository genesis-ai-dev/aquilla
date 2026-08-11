import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ProjectSettings — Advanced LLM settings section.
 *
 * ProjectSettings.tsx renders a <details> element with id="section-advanced-llm"
 * and summary text "Advanced LLM settings". Clicking the summary expands the
 * section to show the provider Base UI RadioGroup (role="radio" items, not
 * native inputs): "Frontier" and "Custom endpoint".
 *
 * This spec: navigate to project settings → click the "Advanced LLM settings"
 * summary → verify the "Frontier" radio is visible → click "Custom endpoint"
 * radio → verify it becomes checked.
 */
test("project settings Advanced LLM section expands and Custom endpoint radio toggles", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `AdvLLM ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/settings/ai`)
  // The <details> summary is "Advanced LLM settings".
  const summary = alice.getByText(/Advanced LLM settings/i)
  await expect(summary).toBeVisible({ timeout: 10_000 })
  await summary.scrollIntoViewIfNeeded()
  await summary.click()

  // After expanding, the provider radios (Base UI role="radio") are visible;
  // "Frontier" is first.
  const section = alice.locator("#section-advanced-llm")
  const radios = section.getByRole("radio")
  const frontierRadio = radios.first()
  await expect(frontierRadio).toBeVisible({ timeout: 3_000 })

  // Base UI radio native inputs are position:absolute; without a positioned
  // ancestor they inflate document scroll past AppShell. Inner Page scroll is
  // fine — the window itself must not be scrollable.
  await expect
    .poll(async () => {
      return alice.evaluate(() => {
        const doc = document.documentElement
        return doc.scrollHeight - doc.clientHeight + window.scrollY
      })
    })
    .toBe(0)

  // The "Custom endpoint" label text is visible.
  const customLabel = alice.getByText(/Custom endpoint/i).first()
  await expect(customLabel).toBeVisible({ timeout: 3_000 })

  // Click the "Custom endpoint" radio.
  await customLabel.click()

  // The custom endpoint radio is now checked.
  const customRadio = radios.nth(1)
  await expect(customRadio).toBeChecked({ timeout: 3_000 })
})
