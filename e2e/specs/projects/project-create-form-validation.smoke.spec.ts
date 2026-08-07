import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ProjectCreateDialog — form validation on submit (Create stays enabled).
 *
 * Clicking Create with missing fields shows inline validation errors.
 */
test("project create dialog shows validation errors when required fields are missing", async ({
  alice,
}) => {
  const dash = new Dashboard(alice)
  await dash.goto()

  const dialog = await dash.openCreateProjectDialog()

  const createBtn = dialog.getByRole("button", { name: /^Create Project$/i })
  await expect(createBtn).toBeEnabled({ timeout: 3_000 })

  await createBtn.click()
  await expect(dialog.getByText(/project title is required/i)).toBeVisible({ timeout: 2_000 })
  await expect(dialog.getByText(/source language is required/i)).toBeVisible({ timeout: 2_000 })
  await expect(dialog.getByText(/target language is required/i)).toBeVisible({ timeout: 2_000 })

  const nameInput = dialog.locator("#project-create-title")
  await nameInput.fill("My Test Project")
  await dialog.locator("#project-create-source").fill("en")
  await createBtn.click()
  await expect(dialog.getByText(/target language is required/i)).toBeVisible({ timeout: 2_000 })

  // Self-contained shape uses chips; an uncommitted draft still counts as primary.
  await dialog.locator("#project-create-target").fill("fr")
  await expect(createBtn).toBeEnabled({ timeout: 2_000 })
  await expect(dialog.getByText(/target language is required/i)).toHaveCount(0)

  await alice.keyboard.press("Escape")
})
