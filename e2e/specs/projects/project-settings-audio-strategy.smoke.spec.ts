import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ProjectSettings — Audio loading section.
 *
 * AudioMediaStrategySection renders four strategy buttons (aria-pressed):
 *   "Lazy (default)", "Stream", "Eager", "Manual"
 *
 * Clicking a different strategy marks the form dirty and shows "Save changes".
 */
test("project settings audio loading strategy selection marks form dirty", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `AudioStrat ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/settings/audio-media`)
  await alice.waitForLoadState("networkidle")

  // "Audio loading" card title is visible.
  await expect(alice.getByText(/Audio loading/i).first()).toBeVisible({ timeout: 10_000 })

  // Scope to the Audio Media section; each strategy button's accessible
  // name is "<name> <description>" (both spans are inside the button), so
  // anchor only the start of the name.
  const section = alice.locator("#section-audio-media")

  // "Lazy (default)" button is initially aria-pressed="true".
  const lazyBtn = section.getByRole("button", { name: /^Lazy \(default\)/i })
  await expect(lazyBtn).toBeVisible({ timeout: 5_000 })
  await expect(lazyBtn).toHaveAttribute("aria-pressed", "true")

  // Click "Eager" — marks form dirty.
  const eagerBtn = section.getByRole("button", { name: /^Eager\b/i })
  await expect(eagerBtn).toBeVisible({ timeout: 5_000 })
  await eagerBtn.click()
  await expect(eagerBtn).toHaveAttribute("aria-pressed", "true")

  // "Save changes" appears.
  const saveBtn = alice.getByRole("button", { name: /Save changes/i })
  await expect(saveBtn).toBeVisible({ timeout: 5_000 })
})
