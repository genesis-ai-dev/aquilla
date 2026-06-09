import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ProjectSettings — AI context controls in the AI Instructions section.
 *
 * The AI Instructions card has three controls not tested elsewhere:
 *   - #context-size select: "small" | "medium" (default) | "large"
 *   - #few-shot-example-format select: "source-and-target" (default) | "target-only"
 *   - #validated-only checkbox (unchecked by default)
 *
 * Each change marks the form dirty ("Save changes" button appears).
 *
 * This spec: navigate to /project/:id/settings → change context-size →
 * verify "Save changes" visible → change few-shot-format → still visible →
 * toggle validated-only → still visible.
 */
test("project settings AI context controls mark form dirty", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `CtxControls ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/settings`)
  await alice.waitForLoadState("networkidle")

  // #context-size select defaults to "medium" — change to "large".
  const contextSizeSelect = alice.locator("#context-size")
  await expect(contextSizeSelect).toBeVisible({ timeout: 10_000 })
  await expect(contextSizeSelect).toHaveValue("medium")
  await contextSizeSelect.selectOption("large")
  await expect(contextSizeSelect).toHaveValue("large")

  // Form is now dirty — "Save changes" appears.
  const saveBtn = alice.getByRole("button", { name: /Save changes/i })
  await expect(saveBtn).toBeVisible({ timeout: 5_000 })

  // #few-shot-example-format defaults to "source-and-target" — change to "target-only".
  const fewShotSelect = alice.locator("#few-shot-example-format")
  await expect(fewShotSelect).toBeVisible({ timeout: 3_000 })
  await expect(fewShotSelect).toHaveValue("source-and-target")
  await fewShotSelect.selectOption("target-only")
  await expect(fewShotSelect).toHaveValue("target-only")

  // #validated-only checkbox — toggle it on.
  const validatedOnlyChk = alice.locator("#validated-only")
  await expect(validatedOnlyChk).toBeVisible({ timeout: 3_000 })
  const wasChecked = await validatedOnlyChk.isChecked()
  await validatedOnlyChk.setChecked(!wasChecked)
  await expect(validatedOnlyChk).toBeChecked({ timeout: 2_000, checked: !wasChecked })

  // "Save changes" is still visible.
  await expect(saveBtn).toBeVisible()
})
