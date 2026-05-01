import { type Page, type Locator, expect } from "@playwright/test"

/** Page object for the project workspace route ("/project/:id"). */
export class Workspace {
  constructor(private readonly page: Page) {}

  async importFile(filePath: string): Promise<void> {
    await this.page.getByRole("button", { name: /^Import$/i }).click()
    await expect(this.page.getByText("Import Files")).toBeVisible({ timeout: 5_000 })
    await this.page.locator('input[type="file"]').setInputFiles(filePath)
    await expect(this.page.getByText("Import Files")).not.toBeVisible({ timeout: 15_000 })
  }

  /** Click a file row in the sidebar, identified by a substring of its name. */
  async openFileBySubstring(nameSubstring: string): Promise<void> {
    await this.page
      .locator("aside")
      .locator("div")
      .filter({ hasText: new RegExp(nameSubstring, "i") })
      .filter({ has: this.page.locator('button[aria-label="File actions"]') })
      .first()
      .click()
  }

  async waitForEditor(): Promise<void> {
    await expect(this.page.locator("[data-cell-id]").first()).toBeVisible({ timeout: 10_000 })
  }

  cellRow(index = 0): Locator {
    return this.page.locator("[data-cell-id]").nth(index)
  }

  /** Click into a cell, type text, blur. Persists on blur per editor design. */
  async editCell(index: number, text: string): Promise<void> {
    const row = this.cellRow(index)
    const target = row.locator(".tiptap [contenteditable], textarea").first()
    await target.click()
    await this.page.keyboard.type(text)
    await this.page.locator("aside").click() // blur outside editor
  }

  async readCell(index: number): Promise<string> {
    return (await this.cellRow(index).textContent()) ?? ""
  }

  /** Open the validation popover on a cell, click Validate, expect emerald
   * indicator (the visible signal a cell is self-validated). */
  async validateCell(index: number): Promise<void> {
    const row = this.cellRow(index)
    const validationButton = row.locator("button[title*='Health']").first()
    await expect(validationButton).toBeVisible({ timeout: 10_000 })
    await validationButton.click()
    const validateAction = this.page.getByRole("button", { name: /validate/i })
    if (await validateAction.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await validateAction.click()
    }
    await expect(row.locator(".text-emerald-500").first()).toBeVisible({ timeout: 10_000 })
  }
}
