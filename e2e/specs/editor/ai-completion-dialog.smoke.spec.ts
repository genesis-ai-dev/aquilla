import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Run AI completions dialog — ConfirmActionDialog.
 *
 * AQU-661: the workspace actions live in the header ⋯ overflow menu. After
 * importing a file with untranslated cells, the menu lists "Run AI completions"
 * (isAvailable when a file is open and the role permits target commits).
 *
 * Selecting it triggers requiresConfirmation → opens ConfirmActionDialog:
 *   - DialogTitle "Run completions"
 *   - DialogDescription names the bounded approved-example draft package and review requirement
 *   - checkbox "I understand this change will be attributed to my account."
 *   - Cancel button (closes dialog)
 *   - "Run AI completions" button (disabled until checkbox checked)
 *
 * This spec verifies the dialog opens and has the expected structure.
 * It does NOT click Confirm (no AI key needed — dialog UI only).
 */
test("AI completions dialog opens with acknowledgement checkbox", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `Completions ${Date.now()}` })
  await openSeededProject(alice, seeded)

  // AQU-661: open the header ⋯ overflow menu, then pick "Run AI completions".
  const moreBtn = alice.getByRole("banner").getByRole("button", { name: /^More$/i })
  await expect(moreBtn).toBeVisible({ timeout: 10_000 })
  await moreBtn.click()
  await alice.getByRole("menuitem", { name: /Run AI completions/i }).click()

  // ConfirmActionDialog opens as a <Dialog> with aria role "dialog".
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // DialogTitle "Run completions"
  await expect(dialog.getByRole("heading", { name: /Run completions/i })).toBeVisible()

  // DialogDescription contains cell count text.
  await expect(
    dialog.locator("p, [role=status], .text-muted-foreground").filter({
      hasText: /Generate an approved-example draft package for the next/i,
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
