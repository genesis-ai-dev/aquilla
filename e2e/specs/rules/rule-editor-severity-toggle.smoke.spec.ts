import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * RuleEditor — Severity button toggle (Minor ↔ Major).
 *
 * RuleEditor.tsx renders two plain <button> elements in a group labeled
 * "Severity": "Minor" and "Major". The selected button has a colored bg;
 * the unselected has bg-muted. Clicking a button sets severity state.
 *
 * There is no aria-pressed, so we check the button's class to infer state.
 * The major button gets "bg-red-500 text-white" when selected.
 * The minor button gets "bg-amber-500 text-white" when selected.
 *
 * This spec: open the inline RuleEditor via "+ Add Rule" (the rules surface
 * refactor replaced the create dialog with an inline editor) → default is
 * "Minor" (amber) → click "Major" → verify it gets the red styling →
 * click "Minor" → verify the color swap → Cancel.
 */
test("rule editor severity toggle switches between Minor and Major", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `SeverityRule ${Date.now()}`
  await dash.createProject({ name })
  await dash.openProject(name)

  await alice.waitForURL(/\/project\/[^/]+\/editor(?:\/file\/[^/]+)?(?:\?|$)/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/project\/([^/]+)/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/rules`)
  await alice.waitForLoadState("networkidle")

  // "+ Add Rule" opens the inline RuleEditor (no dialog).
  const addRuleBtn = alice.getByRole("button", { name: /Add Rule/i })
  await expect(addRuleBtn).toBeVisible({ timeout: 10_000 })
  await addRuleBtn.click()
  await expect(alice.locator("#re-name")).toBeVisible({ timeout: 5_000 })

  // Severity section shows "Minor" and "Major" buttons.
  const minorBtn = alice.getByRole("button", { name: /^Minor$/i }).first()
  const majorBtn = alice.getByRole("button", { name: /^Major$/i }).first()
  await expect(minorBtn).toBeVisible({ timeout: 3_000 })
  await expect(majorBtn).toBeVisible({ timeout: 2_000 })

  // Default severity is "minor" — the Minor button starts selected (amber).
  await expect(minorBtn).toHaveClass(/bg-amber-500/)

  // Click "Major" and verify it gets the red styling.
  await majorBtn.click()
  await expect(majorBtn).toHaveClass(/bg-red-500/, { timeout: 2_000 })
  await expect(minorBtn).not.toHaveClass(/bg-amber-500/)

  // Click "Minor" and verify the color swap.
  await minorBtn.click()
  await expect(minorBtn).toHaveClass(/bg-amber-500/, { timeout: 2_000 })
  await expect(majorBtn).not.toHaveClass(/bg-red-500/)

  // Cancel without saving.
  const cancelBtn = alice.getByRole("button", { name: /^Cancel$/i }).first()
  await cancelBtn.click()
})
