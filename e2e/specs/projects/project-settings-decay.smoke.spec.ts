import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ProjectSettings — Staleness & health (decay) section.
 *
 * DecaySettingsSection renders as a <details> element:
 *   - <summary>Staleness & health</summary>
 *   - Input id="decay-max-hops" (confidence propagation radius — replaced the
 *     retired endorsement-target field, AD-14 amendment 2026-06-04)
 *   - Input id="decay-warn" (attention threshold)
 *
 * Clicking the <summary> expands the section.
 * Changing a value marks the form dirty and shows "Save changes".
 */
test("project settings decay section expands and changing target marks form dirty", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `DecaySettings ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/settings?section=validation`)
  await alice.waitForLoadState("networkidle")

  // The <summary> "Staleness & health" is visible.
  const summary = alice.locator("summary").filter({ hasText: /Staleness.*health/i })
  await expect(summary).toBeVisible({ timeout: 10_000 })

  // Click to expand.
  await summary.click()

  // Max-hops input is now visible.
  const decayTarget = alice.locator("#decay-max-hops")
  await expect(decayTarget).toBeVisible({ timeout: 3_000 })

  // Change the propagation radius.
  const currentValue = await decayTarget.inputValue()
  const newValue = String(Number(currentValue) + 1)
  await decayTarget.fill(newValue)

  // "Save changes" button appears.
  const saveBtn = alice.getByRole("button", { name: /Save changes/i })
  await expect(saveBtn).toBeVisible({ timeout: 5_000 })
})
