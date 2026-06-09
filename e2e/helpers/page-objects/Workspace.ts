import { type Page, type Locator, expect } from "@playwright/test"

/** Page object for the project workspace route ("/project/:id"). */
export class Workspace {
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  async importFile(filePath: string): Promise<void> {
    // Open the ImportDialog — lands on the "landing" screen (card grid).
    await this.page.getByRole("button", { name: /^Import$/i }).click()
    // Navigate to the Upload Files panel by clicking its card.
    await this.page.getByText("Upload Files").click()
    // UploadPanel is now visible with a "Choose Files" button.
    await expect(this.page.getByRole("button", { name: /Choose Files/i })).toBeVisible({
      timeout: 5_000,
    })
    // The panel has two file inputs: file picker + folder picker (webkitdirectory).
    // Target the plain file picker.
    await this.page
      .locator('input[type="file"]:not([webkitdirectory])')
      .setInputFiles(filePath)
    // Selecting a non-Paratext file starts the import immediately (no confirm step).
    // Wait for the dialog to finish: "Choose Files" disappears when the import panel
    // transitions to the "importing" state or the dialog closes on success.
    await expect(
      this.page.getByRole("button", { name: /Choose Files/i }),
    ).not.toBeVisible({ timeout: 15_000 })
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

  private editableTarget(index: number): Locator {
    return this.cellRow(index)
      .locator('textarea, .ProseMirror[contenteditable="true"], [contenteditable="true"]')
      .first()
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
    const target = this.editableTarget(index)
    await target.waitFor({ state: "visible", timeout: 10_000 })
    await target.click()
    await this.page.keyboard.type(text)
    await this.page.locator("aside").click() // blur outside editor
    // Wait for the async IDB commit pipeline to complete (emitTargetCellCommit
    // sets pendingTargetEventIdRef.current in a .then(), so validateCell can
    // immediately follow without a race on the editEventId being null).
    await this.page.waitForTimeout(800)
  }

  async readCell(index: number): Promise<string> {
    return (await this.cellRow(index).textContent()) ?? ""
  }

  /** Validate a cell and assert the emerald indicator appears.
   *
   * The health button uses Base UI's Popover with openOnHover — hover events
   * fire before the click's trigger-press, which can open the popover instead
   * of firing emitValidationChange(). We work around this by:
   *   1. Focusing the button (no hover side-effects)
   *   2. Pressing Space (fires trigger-press without a preceding hover)
   * This routes through the `details.reason === "keyboard"` branch (same
   * effect as trigger-press for EditorTable's handleOpenChange). */
  async validateCell(index: number): Promise<void> {
    const row = this.cellRow(index)
    const validationButton = row.locator("button[title*='Health']").first()
    await expect(validationButton).toBeVisible({ timeout: 10_000 })
    // Focus then Space to avoid hover-triggered popover competing with the press.
    await validationButton.focus()
    await this.page.keyboard.press("Space")
    await expect(row.locator(".text-emerald-500").first()).toBeVisible({ timeout: 10_000 })
  }
}
