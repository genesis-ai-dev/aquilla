import { type Page, type Locator, expect } from "@playwright/test"

/** Page object for the project workspace route ("/project/:id"). */
export class Workspace {
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  async importFile(filePath: string): Promise<void> {
    await this.page.getByRole("button", { name: /^Import$/i }).click()
    await expect(this.page.getByText("Import Files")).toBeVisible({ timeout: 5_000 })
    await this.page.locator('input[type="file"]').setInputFiles(filePath)
    await expect(this.page.getByText("Import Files")).not.toBeVisible({ timeout: 15_000 })
  }

  /** Click a file row in the sidebar, identified by a substring of its name. */
  async openFileBySubstring(nameSubstring: string): Promise<void> {
    const fileLabel = this.page
      .locator("aside")
      .getByText(new RegExp(nameSubstring, "i"))
      .first()
    await expect(fileLabel).toBeVisible({ timeout: 10_000 })
    await fileLabel.click()
  }

  async waitForEditor(): Promise<void> {
    await expect(this.page.locator("[data-cell-id]").first()).toBeVisible({ timeout: 10_000 })
  }

  cellRow(index = 0): Locator {
    return this.page.locator("[data-cell-id]").nth(index)
  }

  /** Click into a cell, type text, blur. Persists on blur per editor design.
   *
   * Cell editable surface is either:
   * - a `<textarea>` (plain markdown / fallback path), or
   * - a TipTap `<EditorContent>` which renders as `.ProseMirror[contenteditable]`
   *   (NOT `.tiptap` — `.tiptap` is a className the user sets, not a default).
   *
   * `[contenteditable="true"]` covers any contenteditable target. Order matters
   * for `.first()`: list textarea first since plain cells are common and the
   * TipTap editor inside the row also has a few non-editable contenteditable
   * children we don't want to match. */
  async editCell(index: number, text: string): Promise<void> {
    const row = this.cellRow(index)
    await row.scrollIntoViewIfNeeded()
    const target = row
      .locator('textarea, .ProseMirror[contenteditable="true"], [contenteditable="true"]')
      .first()
    await target.waitFor({ state: "visible", timeout: 10_000 })
    await target.click()
    await this.page.keyboard.type(text)
    const commitPosted = this.page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/events") &&
        response.status() === 200,
      { timeout: 10_000 },
    )
    await this.page.locator("aside").click() // blur outside editor
    await commitPosted
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
    const validationPosted = this.page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/events") &&
        response.status() === 200,
      { timeout: 10_000 },
    )
    await validationButton.click()
    const validateAction = this.page.getByRole("button", { name: /validate/i })
    if (await validateAction.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await validateAction.click()
    }
    await validationPosted
    await expect(row.locator(".text-emerald-500").first()).toBeVisible({ timeout: 10_000 })
  }
}
