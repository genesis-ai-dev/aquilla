import { type Page, expect } from "@playwright/test"

/**
 * AQU-2342: Living Memory → Checks is ONE list, and one "Add check" button
 * starts every kind of new check. The first step names where the check comes
 * from; clicking a choice opens that store's own editor.
 */
export type AddCheckChoice =
  | "Write a check"
  | "Write an organization check"
  | "Import from a style guide"
  | "Draw style rules from source documents"

export async function startAddCheck(page: Page, choice: AddCheckChoice): Promise<void> {
  const addButton = page.getByRole("button", { name: "Add check" })
  await expect(addButton).toBeVisible({ timeout: 10_000 })
  await addButton.click()
  const chooser = page.getByRole("dialog", { name: "Add a check" })
  await expect(chooser).toBeVisible({ timeout: 3_000 })
  await chooser.getByRole("button", { name: new RegExp(`^${choice}`) }).click()
  await expect(chooser).not.toBeVisible({ timeout: 3_000 })
}
