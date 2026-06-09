import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * ViolationPopover — waive and unwaive a violation.
 *
 * The ViolationPopover (opened by clicking the infraction badge) has:
 *   - "Waive" button → shows reason input + "Confirm" and "Cancel" buttons
 *   - After confirming waive → popover shows "Unwaive" button
 *   - Clicking "Unwaive" → popover shows "Waive" button again
 *
 * This spec: enable Extra whitespace rule → create violation → click badge →
 * click Waive → fill optional reason → Confirm → Unwaive button appears →
 * click Unwaive → Waive button returns.
 */
test("waive and unwaive a rule violation via violation popover", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Waive ${Date.now()}`
  await dash.createProject({ name })
  await dash.openProject(name)

  const projectId = alice.url().split("/project/")[1]?.split("/")[0]
  expect(projectId).toBeTruthy()

  // Enable Extra whitespace rule.
  await alice.goto(`/project/${projectId}/rules`)
  const toggle = alice.getByRole("checkbox", { name: /Extra whitespace enabled/i })
  await expect(toggle).toBeVisible({ timeout: 10_000 })
  if (!(await toggle.isChecked())) {
    await toggle.check()
  }

  // Import file and create a violation.
  await alice.goto(`/project/${projectId}`)
  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()
  const editable = row.locator('textarea, .ProseMirror[contenteditable="true"], [contenteditable="true"]').first()
  await editable.waitFor({ state: "visible", timeout: 10_000 })
  await editable.click()
  await alice.keyboard.insertText("double  space  text")
  await alice.locator("aside").click()

  // Wait for infraction badge.
  const badge = ws.cellRow(0).locator('[aria-label*="issue"]').first()
  await expect(badge).toBeVisible({ timeout: 10_000 })
  await badge.click()

  // ViolationPopover is open — "Waive" button visible.
  const waiveBtn = alice.getByRole("button", { name: /^Waive$/i }).first()
  await expect(waiveBtn).toBeVisible({ timeout: 5_000 })
  await waiveBtn.click()

  // Waive reason form: optional input + Confirm + Cancel.
  const reasonInput = alice.locator('input[placeholder="Reason (optional)"]')
  await expect(reasonInput).toBeVisible({ timeout: 3_000 })
  await reasonInput.fill("intentional for testing")

  const confirmBtn = alice.getByRole("button", { name: /^Confirm$/i })
  await expect(confirmBtn).toBeVisible({ timeout: 3_000 })
  await confirmBtn.click()

  // After waiving — "Unwaive" button appears.
  const unwaiveBtn = alice.getByRole("button", { name: /^Unwaive$/i })
  await expect(unwaiveBtn).toBeVisible({ timeout: 5_000 })

  // Unwaive — "Waive" returns.
  await unwaiveBtn.click()
  await expect(waiveBtn).toBeVisible({ timeout: 5_000 })
})
