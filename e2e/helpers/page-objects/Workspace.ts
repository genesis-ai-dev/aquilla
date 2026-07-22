import { type Page, type Locator, expect } from "@playwright/test"

/** Page object for the project workspace route ("/project/:id/editor"). */
export class Workspace {
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  async importFile(filePath: string): Promise<void> {
    await this.chooseImportFiles(filePath)
    // AQU-310: selecting a file now lands on a Preview panel (parsed cells +
    // counts) instead of starting the upload immediately. Confirm it to kick
    // off the actual bulk upload.
    const confirmBtn = this.page.getByRole("button", { name: /Confirm import/i })
    await expect(confirmBtn).toBeVisible({ timeout: 10_000 })
    await confirmBtn.click()
    await this.waitForImportSettled()
  }

  /** Import an audio/video file. Media files bypass the AQU-310 preview panel
   * (they have no text cells to show) and upload immediately on selection, so
   * there is no "Confirm import" step — see ImportDialog.doImportFiles. */
  async importMediaFile(filePath: string): Promise<void> {
    await this.chooseImportFiles(filePath)
    await this.waitForImportSettled()
  }

  /** Shared import prologue: dismiss the setup checklist, open the
   * ImportDialog's Upload Files panel, and select `filePath`. */
  private async chooseImportFiles(filePath: string): Promise<void> {
    // AQU-244 auto-opens the "Project setup" checklist sheet once per fresh
    // project, and the modal sheet intercepts workspace clicks. Pre-mark it
    // as already-shown for this project, then dismiss it if it beat us to it.
    const projectId = this.page.url().match(/\/project\/([^/?#]+)/)?.[1]
    if (projectId) {
      await this.page.evaluate(
        (key) => localStorage.setItem(key, "1"),
        `codex.setupAutoShown.${decodeURIComponent(projectId)}`,
      )
    }
    const skipChecklist = this.page.getByRole("button", { name: /Skip for now/i })
    if (await skipChecklist.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await skipChecklist.click()
      await expect(skipChecklist).toBeHidden({ timeout: 5_000 })
    }
    // Open the ImportDialog — lands on the "landing" screen (card grid).
    // Use the card's accessible button name rather than a case-sensitive text
    // locator; the product label is "Upload files".
    const uploadCard = this.uploadFilesCard()
    await this.openImportDialog()
    // Navigate to the Upload Files panel by clicking its card.
    await uploadCard.click()
    // UploadPanel is now visible with a "Choose Files" button.
    // Prefer the import dialog's file picker — cell audio upload inputs also
    // match a bare `input[type=file]:not([webkitdirectory])` once the editor
    // has hydrated, which trips Playwright's strict mode.
    const chooseFilesBtn = this.page.getByRole("button", { name: /Choose Files/i })
    await expect(chooseFilesBtn).toBeVisible({ timeout: 5_000 })
    await chooseFilesBtn.locator('input[type="file"]').setInputFiles(filePath)
  }

  private async waitForImportSettled(): Promise<void> {
    // A hidden confirm button is only the transient "Uploading…" state, not a
    // success signal. Wait for the authoritative sidebar row, while surfacing
    // any import error immediately instead of timing out on an unrelated row.
    const fileActions = this.page
      .locator("aside")
      .locator('button[aria-label="File actions"]')
      .first()
    const importError = this.page.getByText(/^Import failed:/i).first()
    let outcome = "pending"
    await expect.poll(async () => {
      if (await importError.isVisible().catch(() => false)) {
        outcome = `error:${(await importError.textContent())?.trim() ?? "Import failed"}`
        return "settled"
      }
      if (await fileActions.isVisible().catch(() => false)) {
        outcome = "success"
        return "settled"
      }
      return "pending"
    }, { timeout: 30_000 }).toBe("settled")
    if (outcome.startsWith("error:")) throw new Error(outcome.slice("error:".length))
  }

  private uploadFilesCard(): Locator {
    return this.page.getByRole("button", { name: /^Upload files/i }).first()
  }

  private async openImportDialog(): Promise<void> {
    const uploadCard = this.uploadFilesCard()
    if (await uploadCard.isVisible({ timeout: 250 }).catch(() => false)) return

    // Header controls can be replaced while project data hydrates. Retry the
    // opener, but first check whether the previous click already opened the
    // dialog so we never click through its overlay.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (await uploadCard.isVisible({ timeout: 250 }).catch(() => false)) return

      const banner = this.page.getByRole("banner")
      const moreActionsBtn = banner.getByRole("button", { name: /More actions/i })
      if (await moreActionsBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await moreActionsBtn.click()
        const importItem = this.page
          .getByRole("menuitem", { name: /^Import$/i })
          .filter({ visible: true })
          .last()
        await expect(importItem).toBeVisible({ timeout: 5_000 })
        try {
          await importItem.click({ timeout: 2_000 })
        } catch (error) {
          // Base UI can open the dialog on pointer-up before Playwright's
          // actionability loop finishes. The new overlay then covers the menu
          // item and makes click() reject even though the intended action won.
          if (!(await uploadCard.isVisible({ timeout: 500 }).catch(() => false))) {
            throw error
          }
          return
        }
      } else {
        const directImportBtn = this.page
          .getByRole("button", { name: /^Import$/i })
          .filter({ visible: true })
          .first()
        await expect(directImportBtn).toBeVisible({ timeout: 10_000 })
        await directImportBtn.click()
      }

      if (await uploadCard.isVisible({ timeout: 3_000 }).catch(() => false)) return
    }

    throw new Error("Import dialog did not open")
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
    return this.targetColumn(index)
      .locator('textarea, .ProseMirror[contenteditable="true"], [contenteditable="true"]')
      .first()
  }

  private targetColumn(index: number): Locator {
    return this.cellRow(index).locator('[data-cell-type="target"]').first()
  }

  private targetReadView(index: number): Locator {
    return this.targetColumn(index).locator("[data-target-read-view]").first()
  }

  async activateTargetCell(index: number): Promise<Locator> {
    const row = this.cellRow(index)
    await row.scrollIntoViewIfNeeded()

    const target = this.editableTarget(index)
    if (!(await target.isVisible({ timeout: 250 }).catch(() => false))) {
      const readView = this.targetReadView(index)
      await expect(readView).toBeVisible({ timeout: 10_000 })
      await readView.click()
    }

    await expect(target).toBeVisible({ timeout: 10_000 })
    await target.click()
    return target
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
    await this.activateTargetCell(index)
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

  /** The per-cell validation toggle. `aria-pressed="true"` means the current
   * user is one of the cell's active validators. */
  validationToggle(index: number): Locator {
    return this.cellRow(index).getByRole("button", { name: /Validate|Validated/i }).first()
  }

  /** Assert the current user has validated this cell (green self-validated). */
  async expectSelfValidated(index: number): Promise<void> {
    const row = this.cellRow(index)
    // CellActionRail children are opacity:0 until hover/focus — reveal first.
    await row.hover()
    await expect(this.validationToggle(index)).toHaveAttribute("aria-pressed", "true", { timeout: 10_000 })
  }

  /** Remove the current user's validation and wait for the row state to settle. */
  async unvalidateCell(index: number): Promise<void> {
    const row = this.cellRow(index)
    const validationButton = this.validationToggle(index)
    await row.hover()
    await expect(validationButton).toHaveAttribute("aria-pressed", "true", { timeout: 10_000 })
    await validationButton.click()
    await expect(validationButton).toHaveAttribute("aria-pressed", "false", { timeout: 15_000 })
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
    // Hover the row first to reveal the CellActionRail (its children have
    // opacity: 0 when not hovered/focused, which makes them invisible to
    // Playwright's toBeVisible() check).
    await row.hover()
    const validationButton = row.getByRole("button", { name: /Validate|Validated/i }).first()
    await expect(validationButton).toBeVisible({ timeout: 10_000 })
    // After validation, the validation button reports the current user's
    // validation through aria-pressed. This is a server-round-trip
    // (IDB → sync-worker → D1 → push back). Check ARIA state instead of CSS
    // because the CellActionRail might have opacity:0 if focus moved away.
    // Retry the keyboard press under full-suite load; occasionally the first
    // focus/Space pair races with the hover-triggered popover and is ignored.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if ((await validationButton.getAttribute("aria-pressed")) === "true") return
      await row.hover()
      await validationButton.focus()
      await this.page.keyboard.press("Space")
      try {
        await expect(validationButton).toHaveAttribute("aria-pressed", "true", { timeout: 5_000 })
        return
      } catch (err) {
        if (attempt === 2) throw err
      }
    }
  }

  /** Open the workspace header ⋯ overflow menu (OverflowMenu). */
  async openHeaderOverflowMenu(): Promise<void> {
    const moreBtn = this.page.getByRole("button", { name: /^More$/i })
    await expect(moreBtn).toBeVisible({ timeout: 10_000 })
    await moreBtn.click()
  }

  /** AQU-331: view settings live in the header overflow menu. */
  async openViewSettingsMenu(): Promise<void> {
    await this.openHeaderOverflowMenu()
    await this.page.getByRole("menuitem", { name: /View settings/i }).click()
  }

  /** Export lives in the primary action dropdown. */
  async openExportDialog(): Promise<void> {
    const banner = this.page.getByRole("banner")
    const moreActionsBtn = banner.getByRole("button", { name: /More actions/i })
    await expect(moreActionsBtn).toBeVisible({ timeout: 10_000 })
    await moreActionsBtn.click()
    await this.page.getByRole("menuitem", { name: /^Export$/i }).click()
  }

  /**
   * Expand the ExportDialog's "Export to another format" section (collapsed
   * by default when the file has a native round-trip download). No-op when
   * already open (e.g. file types without a native format).
   */
  async openExportFormatsSection(): Promise<void> {
    const dialog = this.page.getByRole("dialog")
    const details = dialog
      .locator("details", { has: this.page.getByText("Export to another format") })
      .first()
    await expect(details).toBeVisible({ timeout: 5_000 })
    if ((await details.getAttribute("open")) == null) {
      await details.locator("summary").first().click()
    }
  }

  /** AQU-331: next unfinished lives in the header overflow menu. */
  async jumpNextUnfinished(): Promise<void> {
    await this.openHeaderOverflowMenu()
    await this.page.getByRole("menuitem", { name: /Next unfinished/i }).click()
  }

  /** Read the currently active target cell's text (empty string if untranslated). */
  async readTargetText(index: number): Promise<string> {
    return ((await this.targetColumn(index).textContent()) ?? "").trim()
  }

  /**
   * AQU-602: the lane switcher is the TARGET language tag in the editor's
   * column header (`data-testid="lane-switcher"`). It renders as a dropdown
   * ONLY when the project has a second target lane — otherwise the tag is a
   * static pill. The trigger carries `data-active-lane="<tag>"` (default lane
   * is `""`). Opening it reveals `data-testid="lane-option-<tag>"` items.
   */
  laneSwitcher(): Locator {
    return this.page.getByTestId("lane-switcher")
  }

  /** Switch the active target lane. Pass `""` for the default lane. */
  async switchLane(tag: string): Promise<void> {
    await expect(this.laneSwitcher()).toBeVisible({ timeout: 10_000 })
    await this.laneSwitcher().click()
    const option = this.page.getByTestId(`lane-option-${tag}`)
    await option.click()
    await expect(this.laneSwitcher()).toHaveAttribute("data-active-lane", tag, { timeout: 5_000 })
  }

  /** Read the currently active lane's tag (`""` = default) off the switcher. */
  async readActiveLane(): Promise<string> {
    await expect(this.laneSwitcher()).toBeVisible({ timeout: 10_000 })
    return (await this.laneSwitcher().getAttribute("data-active-lane")) ?? ""
  }
}
