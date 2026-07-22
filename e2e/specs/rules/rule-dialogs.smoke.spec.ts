import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Rules page secondary dialogs:
 *   - RuleImportDialog ("Import from doc" button)
 *   - RuleSuggestFromEditsDialog ("Suggest from edits" button)
 *
 * Both dialogs open from the Rules page toolbar.
 * This spec verifies both open and can be dismissed.
 */
test("Import from doc and Suggest from edits dialogs open on rules page", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `RuleDialogs ${Date.now()}` })
  await alice.goto(`/project/${seeded.projectId}/rules`)
  await alice.waitForLoadState("networkidle")

  // ── 1. "Import from doc" opens RuleImportDialog ──
  const importDocBtn = alice.getByRole("button", { name: /Import from doc/i })
  await expect(importDocBtn).toBeVisible({ timeout: 10_000 })
  await importDocBtn.click()

  const importDialog = alice.getByRole("dialog")
  await expect(importDialog).toBeVisible({ timeout: 5_000 })
  await expect(
    importDialog.getByRole("heading", { name: /Import rules from/i })
  ).toBeVisible()

  // Dismiss.
  await alice.keyboard.press("Escape")
  await expect(importDialog).not.toBeVisible({ timeout: 3_000 })

  // ── 2. "Suggest from edits" opens RuleSuggestFromEditsDialog ──
  const suggestBtn = alice.getByRole("button", { name: /Suggest from edits/i })
  await expect(suggestBtn).toBeVisible({ timeout: 5_000 })
  await suggestBtn.click()

  const suggestDialog = alice.getByRole("dialog")
  await expect(suggestDialog).toBeVisible({ timeout: 5_000 })
  await expect(
    suggestDialog.getByRole("heading", { name: /Suggest rules from/i })
  ).toBeVisible()

  // Dismiss.
  await alice.keyboard.press("Escape")
  await expect(suggestDialog).not.toBeVisible({ timeout: 3_000 })
})
