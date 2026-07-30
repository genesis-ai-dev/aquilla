import { type Page, type Locator, expect } from "@playwright/test"

// A cold editor route hydrates project access, file metadata, sync state, and
// source/target cells before the first row can render. Three isolated smoke
// shards deliberately contend for local CPU/Postgres; 10 seconds is therefore
// an assertion budget, not a safe cold-start watchdog. Keep this below the
// 60-second per-test ceiling so a genuinely stuck editor still fails promptly.
const EDITOR_READY_TIMEOUT_MS = 30_000

interface FilePayload {
  name: string
  mimeType: string
  buffer: Buffer
}

/** Page object for the project workspace route ("/project/:id/editor"). */
export class Workspace {
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  /** Select a file and stop at the human-review preview boundary. */
  async previewImportFile(filePath: string): Promise<void> {
    await this.chooseImportFiles(filePath)
    const confirmBtn = this.page.getByRole("button", { name: /Confirm import/i })
    await expect(confirmBtn).toBeVisible({ timeout: 10_000 })
  }

  /** Select an in-memory payload. Useful when the bytes are a real fixture but
   * its supplied filename intentionally has an unknown legacy extension. */
  async previewImportPayload(payload: FilePayload): Promise<void> {
    await this.chooseImportFiles(payload)
    await expect(this.page.getByRole("button", { name: /Confirm import/i }))
      .toBeVisible({ timeout: 180_000 })
  }

  /** Commit the currently visible import preview and await publication. */
  async confirmImportPreview(): Promise<void> {
    const confirmBtn = this.page.getByRole("button", { name: /Confirm import/i })
    await expect(confirmBtn).toBeVisible({ timeout: 10_000 })
    await confirmBtn.click()
    await this.waitForImportSettled()
  }

  async importFile(filePath: string): Promise<void> {
    await this.previewImportFile(filePath)
    await this.confirmImportPreview()
  }

  /** Select a spreadsheet through the normal Upload files card, accept the
   * auto-detected column mapping, and stop at the shared human-review preview. */
  async previewMappedSpreadsheet(filePath: string): Promise<void> {
    await this.chooseImportFiles(filePath)
    const mapColumns = this.page.getByRole("button", { name: /^Map columns$/i })
    await expect(mapColumns).toBeVisible({ timeout: 10_000 })
    await mapColumns.click()
    await expect(this.page.getByRole("button", { name: /Confirm import/i }))
      .toBeVisible({ timeout: 10_000 })
  }

  /** Import an audio/video file. Media files bypass the AQU-310 preview panel
   * (they have no text cells to show) and upload immediately on selection, so
   * there is no "Confirm import" step — see ImportDialog.doImportFiles. */
  async importMediaFile(filePath: string): Promise<void> {
    await this.chooseImportFiles(filePath)
    await this.waitForImportSettled()
  }

  /**
   * Import through a specialized importer's own panel (Biblica, Macula,
   * Translation Notes …). These panels commit from their own Import button
   * instead of the shared preview/confirm boundary.
   *
   * `optionName` matches the landing card, e.g. /Biblica Study Bible Notes/i.
   */
  async importViaSpecializedPanel(
    optionName: RegExp,
    filePath: string | FilePayload,
    /**
     * Optional panel setup after the file is chosen and before Import —
     * assert or toggle importer options (e.g. Biblica sentence split).
     */
    configure?: (dialog: Locator) => Promise<void>,
  ): Promise<void> {
    await this.dismissSetupChecklist()
    await this.openImportDialog()

    const dialog = this.page.getByRole("dialog")
    const option = dialog.getByRole("button", { name: optionName }).first()
    await expect(option).toBeVisible({ timeout: 8_000 })
    await option.click()

    // Each specialized panel labels its picker after the format it accepts, so
    // scope to the panel's own file input rather than any input on the page.
    const chooseBtn = dialog.getByRole("button", { name: /^Choose .*file$/i }).first()
    await expect(chooseBtn).toBeVisible({ timeout: 5_000 })
    await chooseBtn.locator('input[type="file"]').setInputFiles(filePath)

    if (configure) await configure(dialog)

    const importBtn = dialog.getByRole("button", { name: /^Import$/i }).last()
    await expect(importBtn).toBeEnabled({ timeout: 5_000 })
    await importBtn.click()
    await this.waitForImportSettled()
  }

  /** AQU-244 auto-opens the "Project setup" checklist sheet once per fresh
   * project, and the modal sheet intercepts workspace clicks. Pre-mark it as
   * already-shown for this project, then dismiss it if it beat us to it. */
  private async dismissSetupChecklist(): Promise<void> {
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
  }

  /** Shared import prologue: dismiss the setup checklist, open the
   * ImportDialog's Upload Files panel, and select `filePath`. */
  private async chooseImportFiles(filePath: string | FilePayload): Promise<void> {
    await this.dismissSetupChecklist()
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

  /** Re-import a colliding file through the safe identity-based update path. */
  async reimportFile(filePath: string): Promise<void> {
    await this.openImportDialog()
    await this.uploadFilesCard().click()
    const chooseFilesBtn = this.page.getByRole("button", { name: /Choose Files/i })
    await expect(chooseFilesBtn).toBeVisible({ timeout: 5_000 })
    await chooseFilesBtn.locator('input[type="file"]').setInputFiles(filePath)

    await expect(this.page.getByText(/re-import detected/i)).toBeVisible({ timeout: 10_000 })
    const update = this.page.getByRole("button", { name: "Update existing" }).first()
    await expect(update).toBeVisible()
    await update.click()
    await this.page.getByRole("button", { name: /^Continue$/i }).click()

    const confirm = this.page.getByRole("button", { name: /Confirm import/i })
    await expect(confirm).toBeVisible({ timeout: 10_000 })
    const reconciled = this.page.waitForResponse(
      (response) => response.url().endsWith("/import/reconcile") && response.request().method() === "POST",
      { timeout: 30_000 },
    )
    await confirm.click()
    const response = await reconciled
    if (!response.ok()) {
      throw new Error(`Re-import failed (${response.status()}): ${await response.text()}`)
    }
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

      // Import is a visible header button beside the ⋯ overflow menu.
      const banner = this.page.getByRole("banner")
      const importBtn = banner.getByRole("button", { name: /^Import$/i })
      if (await importBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await importBtn.click()
      } else {
        const moreActionsBtn = banner.getByRole("button", { name: /^More$/i })
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
            if (!(await uploadCard.isVisible({ timeout: 500 }).catch(() => false))) {
              throw error
            }
            return
          }
        } else {
          // A fully hydrated project with no files uses the editor empty-state
          // CTA ("Import a file") instead of the header Import button.
          const directImportBtn = this.page
            .getByRole("button", { name: /^Import(?: a file)?$/i })
            .filter({ visible: true })
            .first()
          await expect(directImportBtn).toBeVisible({ timeout: 10_000 })
          await directImportBtn.click()
        }
      }

      if (await uploadCard.isVisible({ timeout: 3_000 }).catch(() => false)) return
    }

    throw new Error("Import dialog did not open")
  }

  /** Click a file row in the sidebar, identified by a substring of its name. */
  async openFileBySubstring(nameSubstring: string): Promise<void> {
    await this.page
      .locator("aside")
      .getByRole("button", { name: new RegExp(nameSubstring, "i") })
      .first()
      .click()
  }

  async waitForEditor(expectedCellId?: string): Promise<void> {
    // Seeded fixture ids are UUIDs, so they are safe in this quoted attribute
    // selector. Passing the expected id prevents a file navigation from being
    // satisfied by a stale row that belonged to the previously open file.
    const firstCell = expectedCellId
      ? this.page.locator(`[data-cell-id="${expectedCellId}"]`)
      : this.page.locator("[data-cell-id]").first()
    await expect(firstCell).toBeVisible({
      timeout: EDITOR_READY_TIMEOUT_MS,
    })
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
    let activatedFromReadView = false
    if (!(await target.isVisible({ timeout: 250 }).catch(() => false))) {
      const readView = this.targetReadView(index)
      await expect(readView).toBeVisible({ timeout: 10_000 })
      await readView.click()
      activatedFromReadView = true
    }

    await expect(target).toBeVisible({ timeout: 10_000 })
    // A read-view click is the user's one activation. Clicking the newly
    // mounted editor again normalizes IDML's caret through handleClick and can
    // hide focus-placement regressions that only occur on first activation.
    if (!activatedFromReadView) {
      await target.click()
    }
    await expect(target).toBeFocused({ timeout: 10_000 })
    return target
  }

  private async commitTargetCellEdit(index: number, text: string): Promise<void> {
    // Blurring commits immediately. Register the response waiter before the
    // blur so a fast local worker cannot complete the request first.
    const committed = this.page.waitForResponse((response) => {
      if (response.request().method() !== "POST" || !response.ok()) return false
      try {
        return new URL(response.url()).pathname.endsWith("/events")
      } catch {
        return false
      }
    }, { timeout: 20_000 })
    await this.page.locator("aside").click()
    await committed
    await expect(this.targetColumn(index)).toContainText(text, { timeout: 10_000 })
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
    await this.commitTargetCellEdit(index, text)
  }

  /**
   * Reproduce the IDML pointer path from AQU-740: activate a tall empty target
   * from below its text line, type, click that same blank area again, and keep
   * typing. Both clicks must resolve to the real single-line caret.
   */
  async editIdmlCellFromBlankArea(
    index: number,
    firstText: string,
    secondText: string,
  ): Promise<void> {
    const row = this.cellRow(index)
    await row.scrollIntoViewIfNeeded()
    const column = this.targetColumn(index)
    const initialBox = await column.boundingBox()
    expect(initialBox).not.toBeNull()
    expect(initialBox!.height).toBeGreaterThan(60)

    const blankPosition = {
      x: Math.max(4, initialBox!.width / 2),
      y: initialBox!.height - 4,
    }
    await column.click({ position: blankPosition })
    const target = this.editableTarget(index)
    await expect(target).toBeVisible({ timeout: 10_000 })
    await expect(target).toBeFocused({ timeout: 10_000 })
    await this.page.keyboard.type(firstText)

    const caretTop = async (): Promise<number> => target.evaluate((surface) => {
      const selection = surface.ownerDocument.getSelection()
      if (!selection || selection.rangeCount === 0) throw new Error("IDML caret is missing")
      const range = selection.getRangeAt(0)
      const rect = range.getClientRects()[0] ?? range.getBoundingClientRect()
      return rect.top
    })
    const textLineTop = await caretTop()

    const activeBox = await target.boundingBox()
    expect(activeBox).not.toBeNull()
    expect(activeBox!.height).toBeGreaterThan(60)
    await target.click({
      position: {
        x: Math.max(4, activeBox!.width / 2),
        y: activeBox!.height - 4,
      },
    })
    await expect(target).toBeFocused({ timeout: 10_000 })
    expect(Math.abs((await caretTop()) - textLineTop)).toBeLessThan(5)

    await this.page.keyboard.type(secondText)
    await this.commitTargetCellEdit(index, `${firstText}${secondText}`)
  }

  /**
   * Activate a populated IDML cell at an exact read-view text offset. This exercises
   * the read-view → ProseMirror remount boundary from a single real pointer
   * click; a second editor click would hide activation-placement regressions.
   */
  async editIdmlCellAtTextOffset(
    index: number,
    textOffset: number,
    insertedText: string,
    expectedText: string,
  ): Promise<void> {
    const row = this.cellRow(index)
    await row.scrollIntoViewIfNeeded()
    const readView = this.targetReadView(index)
    await expect(readView).toBeVisible({ timeout: 10_000 })

    const point = await readView.evaluate((element, offset) => {
      const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      let remaining = offset
      let node: Text | null = null
      let nodeOffset = 0
      while (walker.nextNode()) {
        const candidate = walker.currentNode as Text
        if (remaining <= candidate.data.length) {
          node = candidate
          nodeOffset = remaining
          break
        }
        remaining -= candidate.data.length
      }
      if (!node) throw new Error(`IDML slot has no text position at offset ${offset}`)
      const range = element.ownerDocument.createRange()
      range.setStart(node, nodeOffset)
      range.collapse(true)
      const rect = range.getClientRects()[0] ?? range.getBoundingClientRect()
      return { x: rect.left, y: rect.top + Math.max(1, rect.height / 2) }
    }, textOffset)

    await this.page.mouse.click(point.x, point.y)
    const target = this.editableTarget(index)
    await expect(target).toBeVisible({ timeout: 10_000 })
    await expect(target).toBeFocused({ timeout: 10_000 })
    await expect.poll(() => target.evaluate((surface) => {
      const editor = (surface as HTMLElement & {
        editor?: { state: { selection: { $from: { parentOffset: number } } } }
      }).editor
      return editor?.state.selection.$from.parentOffset ?? -1
    })).toBe(textOffset)

    await this.page.keyboard.type(insertedText)
    await this.commitTargetCellEdit(index, expectedText)
  }

  /** Replace the complete target value, then wait for its authoritative commit. */
  async replaceCell(index: number, text: string): Promise<void> {
    const target = await this.activateTargetCell(index)
    await target.fill(text)
    await this.commitTargetCellEdit(index, text)
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

    const removeButton = this.page.getByRole("button", {
      name: "Remove your validation",
      exact: true,
    })
    await expect(removeButton).toBeVisible({ timeout: 8_000 })
    // The validation popover is hover-aware. Moving the pointer from the
    // trigger to its portalled content can close and remount the content while
    // Playwright is checking pointer stability. Keep the pointer on the
    // trigger and activate the real focused button from the keyboard instead.
    await removeButton.focus()
    await this.page.keyboard.press("Enter")
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

  /** Open the workspace header ⋯ overflow menu (project-scoped actions). */
  async openHeaderOverflowMenu(): Promise<void> {
    const moreBtn = this.page.getByRole("button", { name: /^More$/i })
    await expect(moreBtn).toBeVisible({ timeout: 10_000 })
    await moreBtn.click()
  }

  /** Open the chapter-row File options ⋯ menu (file-scoped actions). */
  async openFileOverflowMenu(): Promise<void> {
    const fileOptionsBtn = this.page.getByRole("button", { name: /^File options$/i })
    await expect(fileOptionsBtn).toBeVisible({ timeout: 10_000 })
    await fileOptionsBtn.click()
  }

  /** Editor settings live in the file options overflow menu. */
  async openViewSettingsMenu(): Promise<void> {
    await this.openFileOverflowMenu()
    await this.page.getByRole("menuitem", { name: /Editor settings/i }).click()
  }

  /** Export lives in the file options overflow menu. */
  async openExportDialog(): Promise<void> {
    await this.openFileOverflowMenu()
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

  /** Next unfinished lives in the file options overflow menu. */
  async jumpNextUnfinished(): Promise<void> {
    await this.openFileOverflowMenu()
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
