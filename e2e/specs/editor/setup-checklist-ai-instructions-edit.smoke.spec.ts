import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * AiInstructionsStep — textarea edit and reset-to-default inside the
 * SetupChecklistDrawer.
 *
 * AiInstructionsStep.tsx renders:
 *   - A textarea pre-filled with the default system prompt
 *   - A char count label: "{n} characters"
 *   - A "Reset to default" button (disabled when content is the default)
 *   - A "Save instructions" button
 *
 * This spec: open the setup checklist → expand "Set translation instructions"
 * → verify textarea is visible → clear it and type new text → verify char
 * count reflects new length → verify "Reset to default" becomes enabled →
 * click "Reset to default" → verify "Reset to default" is disabled again.
 */
test("setup checklist AI instructions textarea edit and reset", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `AiInstr ${Date.now()}` })
  await openSeededProject(alice, seeded)

  // Open the setup checklist.
  const chip = alice.getByRole("button", { name: /Setup:/i })
  await expect(chip).toBeVisible({ timeout: 10_000 })
  await chip.click()

  await expect(alice.getByRole("heading", { name: /Project setup/i })).toBeVisible({
    timeout: 5_000,
  })

  // Find the "Set translation instructions" checklist item and expand it.
  const instructionsItem = alice.locator("button[aria-expanded]").filter({
    hasText: /Set translation instructions/i,
  })
  await expect(instructionsItem).toBeVisible({ timeout: 5_000 })

  // If already collapsed, click to expand.
  const isExpanded = await instructionsItem.getAttribute("aria-expanded")
  if (isExpanded !== "true") {
    await instructionsItem.click()
  }
  await expect(instructionsItem).toHaveAttribute("aria-expanded", "true", { timeout: 2_000 })

  // Textarea is visible with content.
  const textarea = alice.locator("textarea").first()
  await expect(textarea).toBeVisible({ timeout: 3_000 })

  // Clear textarea and type new text. The char count should reflect new length.
  await textarea.selectText()
  await textarea.fill("Test instructions text")

  // Char count updates — "22 characters".
  await expect(alice.getByText(/22 characters/)).toBeVisible({ timeout: 2_000 })

  // "Reset to default" is enabled (no longer the default text).
  const resetBtn = alice.getByRole("button", { name: /Reset to default/i })
  await expect(resetBtn).toBeEnabled({ timeout: 2_000 })

  // Click "Reset to default" → button goes back to disabled.
  await resetBtn.click()
  await expect(resetBtn).toBeDisabled({ timeout: 2_000 })
})
