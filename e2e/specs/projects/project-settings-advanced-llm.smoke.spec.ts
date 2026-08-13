import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ProjectSettings — Advanced LLM settings section.
 *
 * The AI pane renders Advanced LLM as a SettingsGroup (label "Advanced LLM
 * settings") with a provider RadioGroup: "Frontier" and "Custom endpoint".
 * Controls are always visible (no collapsed <details>).
 *
 * This spec: navigate to AI settings → verify the Frontier radio → pick
 * Custom endpoint → verify it becomes checked.
 */
test("project settings Advanced LLM shows provider radios and Custom endpoint toggles", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `AdvLLM ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/settings/ai`)
  await expect(alice.getByText(/Advanced LLM settings/i).first()).toBeVisible({ timeout: 10_000 })

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
  const customLabel = section.getByText(/Custom endpoint/i).first()
  await expect(customLabel).toBeVisible({ timeout: 3_000 })

  // Click the "Custom endpoint" radio.
  await customLabel.click()

  // The custom endpoint radio is now checked.
  const customRadio = radios.nth(1)
  await expect(customRadio).toBeChecked({ timeout: 3_000 })
})
