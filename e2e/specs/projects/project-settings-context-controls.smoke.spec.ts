import { test, expect } from "../../helpers/multi-user"
import { expectSelectValue, pickSelectOption } from "../../helpers/base-ui"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ProjectSettings — AI context controls in the AI Instructions section.
 *
 * The AI Instructions card has three controls not tested elsewhere
 * (Base UI select triggers + checkbox):
 *   - #context-size select: Small | Medium (default) | Large
 *   - #few-shot-example-format select: "Source + target (default)" | "Target only"
 *   - "Approved examples only" trust boundary (always checked and locked)
 *
 * Each change marks the form dirty ("Save changes" button appears).
 *
 * This spec: navigate to /project/:id/settings → change context-size →
 * verify "Save changes" visible → change few-shot-format → still visible →
 * verify approved-only retrieval cannot be disabled.
 */
test("project settings AI context controls mark form dirty", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `CtxControls ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/settings/ai`)
  await alice.waitForLoadState("networkidle")

  // #context-size select defaults to "Medium" — change to "Large".
  const contextSizeSelect = alice.locator("#context-size")
  await expect(contextSizeSelect).toBeVisible({ timeout: 10_000 })
  await expectSelectValue(contextSizeSelect, /Medium/)
  await pickSelectOption(alice, contextSizeSelect, /Large/)
  await expectSelectValue(contextSizeSelect, /Large/)

  // Form is now dirty — "Save changes" appears.
  const saveBtn = alice.getByRole("button", { name: /Save changes/i })
  await expect(saveBtn).toBeVisible({ timeout: 5_000 })

  // #few-shot-example-format defaults to "Source + target" — change to "Target only".
  const fewShotSelect = alice.locator("#few-shot-example-format")
  await expect(fewShotSelect).toBeVisible({ timeout: 3_000 })
  await expectSelectValue(fewShotSelect, /Source \+ target/)
  await pickSelectOption(alice, fewShotSelect, "Target only")
  await expectSelectValue(fewShotSelect, "Target only")

  const approvedOnlyChk = alice.getByRole("checkbox", { name: "Approved examples only" })
  await expect(approvedOnlyChk).toBeVisible({ timeout: 3_000 })
  await expect(approvedOnlyChk).toBeChecked()
  await expect(approvedOnlyChk).toBeDisabled()

  // "Save changes" is still visible.
  await expect(saveBtn).toBeVisible()
})
