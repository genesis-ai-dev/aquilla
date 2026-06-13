import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ProjectCreateDialog — form validation (Create button disabled until name + source filled).
 *
 * ProjectCreateDialog.tsx `canSubmit()` returns false if:
 *   - name.trim() is empty, OR
 *   - sourceLanguage.trim() is empty
 *
 * The "Create" button is disabled when canSubmit() is false.
 *
 * This spec: open "+ New Project" dialog → verify "Create" is disabled →
 * fill project name only → still disabled (no source) → fill source language →
 * "Create" becomes enabled.
 */
test("project create dialog Create button requires name and source language", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()

  // Open the "+ New Project" dialog.
  const newProjectBtn = alice.getByRole("button", { name: /\+ New Project/i })
  await expect(newProjectBtn).toBeVisible({ timeout: 10_000 })
  await newProjectBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // "Create Project" button is initially disabled (empty name + source).
  const createBtn = alice.getByRole("button", { name: /^Create Project$/i })
  await expect(createBtn).toBeDisabled({ timeout: 3_000 })

  // Fill project name only — still disabled (source is empty by default).
  const nameInput = dialog.locator("#name")
  await nameInput.fill("My Test Project")
  // Source might auto-populate; clear it to test the disabled state.
  const sourceInput = dialog.locator("#source")
  await sourceInput.fill("")
  await expect(createBtn).toBeDisabled({ timeout: 2_000 })

  // Fill source language — still disabled: the default (bilingual) project
  // shape also requires a target language (canSubmit in
  // ProjectCreateDialog.tsx; only the "source-only" shape waives it).
  await sourceInput.fill("en")
  await expect(createBtn).toBeDisabled({ timeout: 2_000 })

  // Fill target language — Create becomes enabled.
  await dialog.locator("#target").fill("fr")
  await expect(createBtn).toBeEnabled({ timeout: 2_000 })

  // Close dialog without submitting.
  await alice.keyboard.press("Escape")
})
