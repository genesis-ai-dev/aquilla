import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Run AI completions dialog — ConfirmActionDialog.
 *
 * PrimaryActionButton renders the default workspace action. After importing a
 * file with untranslated cells the default action is "Run AI completions"
 * (isDefault returns true when translated < total).
 *
 * Clicking the button triggers requiresConfirmation → opens ConfirmActionDialog:
 *   - DialogTitle "Run completions"
 *   - DialogDescription "Generate translations for the next N untranslated cells..."
 *   - checkbox "I understand this change will be attributed to my account."
 *   - Cancel button (closes dialog)
 *   - "Run AI completions" button (disabled until checkbox checked)
 *
 * This spec verifies the dialog opens and has the expected structure.
 * It does NOT click Confirm (no AI key needed — dialog UI only).
 */
test("AI completions dialog opens with acknowledgement checkbox", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Completions ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // The PrimaryActionButton renders the default action. With all cells
  // untranslated, "Run AI completions" is the default (isDefault: translated < total).
  const runBtn = alice.getByRole("button", { name: /Run AI completions/i }).first()
  await expect(runBtn).toBeVisible({ timeout: 10_000 })
  await runBtn.click()

  // ConfirmActionDialog opens as a <Dialog> with aria role "dialog".
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // DialogTitle "Run completions"
  await expect(dialog.getByRole("heading", { name: /Run completions/i })).toBeVisible()

  // DialogDescription contains cell count text.
  await expect(
    dialog.locator("p, [role=status], .text-muted-foreground").filter({
      hasText: /Generate translations for the next/i,
    }).first()
  ).toBeVisible({ timeout: 5_000 })

  // Checkbox with acknowledgement label (shadcn Checkbox — role="checkbox";
  // the native input is hidden and no longer actionable).
  const checkbox = dialog.getByRole("checkbox")
  await expect(checkbox).toBeVisible()
  await expect(checkbox).not.toBeChecked()
  await expect(
    dialog.getByText(/I understand this change will be attributed to my account/i)
  ).toBeVisible()

  // Confirm button is disabled until checkbox is checked.
  const confirmBtn = dialog.getByRole("button", { name: /Run AI completions/i })
  await expect(confirmBtn).toBeDisabled()

  // Checking the checkbox enables the confirm button.
  await checkbox.check()
  await expect(confirmBtn).toBeEnabled()

  // Cancel closes without running.
  await dialog.getByRole("button", { name: /Cancel/i }).click()
  await expect(dialog).not.toBeVisible({ timeout: 3_000 })
})
