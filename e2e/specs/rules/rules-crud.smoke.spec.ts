import { test, expect } from "../../helpers/multi-user"
import { startAddCheck } from "../../helpers/page-objects/ChecksList"
import {
  jwtFor,
  seedProjectWithFile,
} from "../../helpers/seed-project"

/**
 * Surface session: Rules CRUD chrome — create/edit/delete project rules, org
 * rules, and secondary dialogs. One `{ alice }` → one resetBackend().
 * Violation detection stays in violation.smoke.spec.ts.
 */

test("rules page create, edit, delete, and dialogs surface session", async ({ alice }) => {
  test.setTimeout(120_000)

  const seeded = await seedProjectWithFile(await jwtFor(alice.username), {
    name: `RulesCrud ${Date.now()}`,
  })
  await alice.goto(`/project/${seeded.projectId}/rules`)

  await test.step("Add check → Write a check opens the editor and Cancel dismisses", async () => {
    await startAddCheck(alice, "Write a check")

    const dialog = alice.getByRole("dialog")
    await expect(dialog).toBeVisible({ timeout: 3_000 })
    await expect(
      dialog.locator('input[placeholder="e.g. Preserve numbers"]'),
    ).toBeVisible({ timeout: 3_000 })
    await expect(
      dialog.locator('input[placeholder="Numbers in source must appear in target"]'),
    ).toBeVisible({ timeout: 3_000 })

    await dialog.getByRole("button", { name: /Cancel/i }).first().click()
    await expect(dialog).not.toBeVisible({ timeout: 3_000 })
    await expect(alice.getByRole("button", { name: "Add check" })).toBeEnabled({ timeout: 3_000 })
  })

  const editRuleName = `TestRule ${Date.now()}`
  await test.step("create rule then Edit opens inline RuleEditor pre-filled", async () => {
    await startAddCheck(alice, "Write a check")

    const dialog = alice.getByRole("dialog")
    await expect(dialog).toBeVisible({ timeout: 3_000 })
    const nameInput = dialog.locator('input[placeholder="e.g. Preserve numbers"]')
    await expect(nameInput).toBeVisible({ timeout: 3_000 })
    await nameInput.fill(editRuleName)
    await dialog.locator("#re-pat").fill("foo")

    const saveBtn = dialog.getByRole("button", { name: /Create rule/i })
    await expect(saveBtn).toBeEnabled({ timeout: 3_000 })
    await saveBtn.click()
    await expect(dialog).not.toBeVisible({ timeout: 5_000 })
    await expect(alice.getByText(editRuleName).first()).toBeVisible({ timeout: 5_000 })

    const editBtn = alice.getByRole("button", { name: "Edit rule" }).first()
    await expect(editBtn).toBeVisible({ timeout: 5_000 })
    await editBtn.click()

    const editNameInput = alice.locator('input[placeholder="e.g. Preserve numbers"]')
    await expect(editNameInput).toBeVisible({ timeout: 3_000 })
    await expect(editNameInput).toHaveValue(editRuleName, { timeout: 3_000 })
    await alice.getByRole("button", { name: /Cancel/i }).first().click()
    await expect(editNameInput).not.toBeVisible({ timeout: 3_000 })
  })

  await test.step("delete a custom rule removes it from the list", async () => {
    await startAddCheck(alice, "Write a check")

    const ruleName = `Delete Me ${Date.now()}`
    const nameInput = alice.locator('input[placeholder="e.g. Preserve numbers"]')
    await expect(nameInput).toBeVisible({ timeout: 5_000 })
    await nameInput.fill(ruleName)
    await alice.locator("#re-pat").fill("foo")

    const saveBtn = alice.getByRole("button", { name: /^Create rule$/ })
    await expect(saveBtn).toBeEnabled({ timeout: 3_000 })
    await saveBtn.click()

    const ruleText = alice.getByText(ruleName)
    await expect(ruleText.first()).toBeVisible({ timeout: 5_000 })

    // RulesSurface deletes immediately (no confirm dialog); scope trash to the row.
    const ruleRow = alice.locator("li").filter({ hasText: ruleName })
    await ruleRow.locator("button:has(svg.lucide-trash-2)").click()
    await expect(ruleText.first()).not.toBeVisible({ timeout: 5_000 })
  })

  const orgRuleName = `OrgRule ${Date.now()}`
  await test.step("Add check → organization check creates an org-scoped rule", async () => {
    await startAddCheck(alice, "Write an organization check")

    const dialog = alice.getByRole("dialog")
    await expect(dialog).toBeVisible({ timeout: 3_000 })
    await dialog.locator('input[placeholder="e.g. Preserve numbers"]').fill(orgRuleName)
    await dialog.locator("#re-pat").fill("org-pattern")

    const saveBtn = dialog.getByRole("button", { name: /Create rule/i })
    await expect(saveBtn).toBeEnabled({ timeout: 3_000 })
    await saveBtn.click()
    await expect(dialog).not.toBeVisible({ timeout: 5_000 })
    await expect(alice.getByText(orgRuleName).first()).toBeVisible({ timeout: 5_000 })
  })

  await test.step("org rule edit pencil opens and closes inline RuleEditor", async () => {
    const editRuleNameOrg = `EditRule ${Date.now()}`
    await startAddCheck(alice, "Write an organization check")

    const dialog = alice.getByRole("dialog")
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    await dialog.locator("#re-name").fill(editRuleNameOrg)
    await dialog.locator("#re-pat").fill("edit-test-pattern")

    const saveBtn = dialog.getByRole("button", { name: /^Create rule$/ })
    await expect(saveBtn).toBeEnabled({ timeout: 3_000 })
    await saveBtn.click()
    await expect(dialog).not.toBeVisible({ timeout: 5_000 })
    await expect(alice.getByText(editRuleNameOrg)).toBeVisible({ timeout: 5_000 })

    // Prior step left another org rule — scope Edit to this row.
    const orgRow = alice.locator("li").filter({ hasText: editRuleNameOrg })
    const editBtn = orgRow.getByRole("button", { name: "Edit org rule" })
    await expect(editBtn).toBeVisible({ timeout: 10_000 })
    await editBtn.click()

    const inlineEditor = orgRow.locator("#re-pat")
    await expect(inlineEditor).toBeVisible({ timeout: 5_000 })
    await expect(inlineEditor).toHaveValue("edit-test-pattern")
    await editBtn.click()
    await expect(inlineEditor).not.toBeVisible({ timeout: 3_000 })
  })

  await test.step("Import from a style guide opens; rule suggestions live in the list", async () => {
    await startAddCheck(alice, "Import from a style guide")

    // Scoped by name: the "Add check" chooser is a dialog too, and can still be
    // finishing its close animation when this one closes.
    const importDialog = alice.getByRole("dialog", { name: /Import rules from/i })
    await expect(importDialog).toBeVisible({ timeout: 5_000 })
    await expect(
      importDialog.getByRole("heading", { name: /Import rules from/i }),
    ).toBeVisible()
    await alice.keyboard.press("Escape")
    await expect(importDialog).not.toBeVisible({ timeout: 3_000 })

    // Suggestions are reviewed in place at the foot of the project rules
    // list — no modal to open and lose them in.
    await expect(
      alice.getByRole("button", { name: /Suggest rules from my edits/i }),
    ).toBeVisible({ timeout: 5_000 })
    await expect(alice.getByRole("textbox", { name: /What the suggested rules should be about/i })).toBeVisible()
  })
})
