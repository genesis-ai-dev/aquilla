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

  const newProjectBtn = alice.getByRole("button", { name: /\+ New Project/i })
  await expect(newProjectBtn).toBeVisible({ timeout: 10_000 })
  await newProjectBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  const createBtn = alice.getByRole("button", { name: /^Create Project$/i })
  await expect(createBtn).toBeEnabled({ timeout: 3_000 })

  await createBtn.click()
  await expect(dialog.getByText(/project name is required/i)).toBeVisible({ timeout: 2_000 })

  const nameInput = dialog.locator("#name")
  await nameInput.fill("My Test Project")
  const sourceInput = dialog.locator("#source")
  await sourceInput.fill("")
  await createBtn.click()
  await expect(dialog.getByText(/source language is required/i)).toBeVisible({ timeout: 2_000 })

  await sourceInput.fill("en")
  await createBtn.click()
  await expect(dialog.getByText(/target language is required/i)).toBeVisible({ timeout: 2_000 })

  await dialog.locator("#target").fill("fr")
  await expect(createBtn).toBeEnabled({ timeout: 2_000 })

  await alice.keyboard.press("Escape")
})
