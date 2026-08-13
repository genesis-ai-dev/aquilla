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

  /** Select and commit one translation through the eBible corpus picker. */
  async importEBibleCorpus(translationTitle: string): Promise<void> {
    await this.dismissSetupChecklist()
    await this.openImportDialog()

    const dialog = this.page.getByRole("dialog")
    const ebibleCard = dialog.getByRole("button", { name: /^eBible Corpus/i }).first()
    await expect(ebibleCard).toBeVisible({ timeout: 5_000 })
    await ebibleCard.click()

    const search = dialog.getByRole("textbox", { name: "Search eBible translations" })
    await expect(search).toBeEnabled({ timeout: 10_000 })
    await search.fill(translationTitle)

    const result = dialog.locator("button").filter({ hasText: translationTitle }).first()
    await expect(result).toBeVisible({ timeout: 5_000 })
    await result.click()

    const importButton = dialog.getByRole("button", { name: /^Import$/i }).last()
    await expect(importButton).toBeEnabled({ timeout: 5_000 })
    await importButton.click()
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

  /** Click a file row in the sidebar, identified by a substring of its name.
   * Anchored to the file rows themselves: sidebar chrome (e.g. the history
   * arrows) embeds the current file's name in its accessible labels, so a
   * bare role+name match inside <aside> can grab the wrong button. */
  async openFileBySubstring(nameSubstring: string): Promise<void> {
    await this.page
      .locator('aside [data-showcase="sidebar.file"]')
      .filter({ hasText: new RegExp(nameSubstring, "i") })
      .first()
      .click()
  }

  /** Wait for a named file to be present in the authoritative sidebar inventory. */
  async waitForFileInSidebar(nameSubstring: string): Promise<void> {
    await expect(
      this.page.locator("aside").getByText(nameSubstring, { exact: false }).first(),
    ).toBeVisible({ timeout: EDITOR_READY_TIMEOUT_MS })
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
      await expect(readView).toBeVisible({ timeout: EDITOR_READY_TIMEOUT_MS })
      await readView.click()
      activatedFromReadView = true
    }

    await expect(target).toBeVisible({ timeout: EDITOR_READY_TIMEOUT_MS })
    // A read-view click is the user's one activation. Clicking the newly
    // mounted editor again normalizes IDML's caret through handleClick and can
    // hide focus-placement regressions that only occur on first activation.
    if (!activatedFromReadView) {
      await target.click()
    }
    await expect(target).toBeFocused({ timeout: EDITOR_READY_TIMEOUT_MS })
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
   *
   * `expectedText` is what the cell should hold after the commit. It defaults
   * to the concatenated input, but AQU-758 sanitizes whitespace at entry
   * (doubled spaces collapse to one), so callers typing deliberate whitespace
   * runs must pass the sanitized result explicitly.
   */
  async editIdmlCellFromBlankArea(
    index: number,
    firstText: string,
    secondText: string,
    expectedText = `${firstText}${secondText}`,
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
    await this.commitTargetCellEdit(index, expectedText)
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

  /**
   * AQU-740: type a draft into an IDML target, then Backspace it away again.
   * Deleting a slot's final character used to let the browser drop the emptied
   * slot span, which the round-trip guard refused — the character stuck and
   * the "protected formatting" banner appeared. The cell must end exactly as
   * it started (untranslated, no commit), with every protected anchor intact.
   */
  async deleteIdmlDraftToEmpty(
    index: number,
    draft: string,
    expectedSlotCount: number,
  ): Promise<void> {
    const target = await this.activateTargetCell(index)
    // Character-style IDs are structural metadata, not translator-facing UI.
    // Native title attributes used to show a distracting raw InDesign tooltip
    // whenever the pointer rested over an active slot.
    await expect(target.locator(".idml-style-boundary[title]")).toHaveCount(0)
    await expect(target.locator("span[data-idml-slot][data-idml-character-style]"))
      .toHaveCount(expectedSlotCount)
    await this.page.keyboard.type(draft)
    await expect(target).toContainText(draft)

    for (let press = 0; press < draft.length; press += 1) {
      await this.page.keyboard.press("Backspace")
    }
    await this.expectEmptyIdmlTarget(target)
    // The protected anchors must survive the emptied draft.
    await expect(target.locator("span[data-idml-slot]")).toHaveCount(expectedSlotCount)
    await expect(
      this.page.getByText(/This edit would remove protected InDesign formatting/i),
    ).toHaveCount(0)
    await this.page.keyboard.press("Escape")
    await expect(target).toBeHidden()
  }

  /**
   * AQU-810: type into an IDML target through a real IME composition session.
   * The raw keydown (keyCode 229) plus CDP `Input.imeSetComposition` drive
   * Chromium's actual IME pipeline — the same compositionstart/update and
   * non-cancelable `insertCompositionText` beforeinput sequence a macOS
   * Japanese or Devanagari input method produces — and `Input.insertText`
   * commits the candidate. The committed text must land exactly once: the
   * regression echoed every intermediate update and left the raw romaji
   * keystrokes between the copies. Ends untranslated (draft backspaced away,
   * Escape), like `deleteIdmlDraftToEmpty`, so later assertions on the cell
   * still hold.
   */
  /**
   * An emptied IDML target is not textually blank in the DOM: the slot holding
   * the caret renders a zero-width-space caret anchor (AQU-810) so the browser
   * can keep the caret — and IME compositions — inside the span. The anchor is
   * decoration-only and never committed, so "empty" means no text beyond it.
   */
  private async expectEmptyIdmlTarget(target: Locator): Promise<void> {
    await expect.poll(() => target.evaluate((element) =>
      (element.textContent ?? "").replace(/\u200b/g, ""))).toBe("")
  }

  async composeIdmlImeDraft(
    index: number,
    compositionUpdates: string[],
    committedText: string,
  ): Promise<void> {
    const target = await this.activateTargetCell(index)
    const slot = target.locator('span[data-idml-slot="0"]')
    const session = await this.page.context().newCDPSession(this.page)
    try {
      // The keystroke that starts a composition reaches the page as a plain
      // keydown with keyCode 229 and isComposing still false — the exact
      // shape that used to leak a literal "k" into the slot.
      await session.send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: compositionUpdates[0] ?? "k",
        code: "KeyK",
        windowsVirtualKeyCode: 229,
        nativeVirtualKeyCode: 229,
      })
      for (const update of compositionUpdates) {
        await session.send("Input.imeSetComposition", {
          text: update,
          selectionStart: update.length,
          selectionEnd: update.length,
        })
        // Real IME keystrokes arrive at human cadence, so ProseMirror's
        // batched mutation reads keep pace with the browser's composition
        // node. CDP can outrun them, which no keyboard can — wait for the
        // editor state to absorb each update before sending the next.
        await expect.poll(() => target.evaluate((el) => {
          const editor = (el as HTMLElement & { editor?: { state: { doc: { textContent: string } } } }).editor
          return (editor?.state.doc.textContent ?? "").replace(/\u200b/g, "")
        })).toBe(update)
      }
      await session.send("Input.insertText", { text: committedText })
    } finally {
      await session.detach()
    }
    await expect.poll(() => slot.evaluate((element) => element.textContent))
      .toBe(committedText)

    for (let press = 0; press < committedText.length; press += 1) {
      await this.page.keyboard.press("Backspace")
    }
    await this.expectEmptyIdmlTarget(target)
    await this.page.keyboard.press("Escape")
    await expect(target).toBeHidden()
  }

  /**
   * AQU-740: Option/Ctrl+Backspace at the end of a trailing space must remove
   * that space and its adjacent word in one operation, not require one press
   * for whitespace and another for the word.
   */
  async deleteIdmlWordPastTrailingSpace(index: number): Promise<void> {
    const target = await this.activateTargetCell(index)
    await this.page.keyboard.type("alpha beta ")
    const slot = target.locator('span[data-idml-slot="0"]')
    await expect.poll(() => slot.evaluate((element) => element.textContent))
      .toBe("alpha beta ")

    await this.page.keyboard.press("Alt+Backspace")
    await expect.poll(() => slot.evaluate((element) => element.textContent))
      .toBe("alpha ")

    // Restore the original untranslated state without committing a draft.
    await this.page.keyboard.press("ControlOrMeta+A")
    await this.page.keyboard.press("Backspace")
    await expect(target).toHaveText("")
    await this.page.keyboard.press("Escape")
    await expect(target).toBeHidden()
  }

  /**
   * AQU-740: the cheap read view and ProseMirror must count a rendered <br>
   * identically. Commit two lines, click after the final character on line two,
   * and prove the next character appends instead of landing one position early.
   */
  async verifyIdmlMultilineReentry(index: number): Promise<void> {
    let target = await this.activateTargetCell(index)
    await this.page.keyboard.type("abc")
    await this.page.keyboard.press("Enter")
    await this.page.keyboard.type("xyz")
    const multilineCommitted = this.page.waitForResponse((response) => {
      if (response.request().method() !== "POST" || !response.ok()) return false
      try {
        return new URL(response.url()).pathname.endsWith("/events")
      } catch {
        return false
      }
    }, { timeout: 20_000 })
    await this.page.locator("aside").click()
    await multilineCommitted

    const readView = this.targetReadView(index)
    await expect(readView).toBeVisible({ timeout: 10_000 })
    const slot = readView.locator('span[data-idml-slot="0"]')
    await expect(slot.locator("br")).toHaveCount(1)
    await expect(slot).toHaveText("abcxyz")
    const point = await slot.evaluate((element) => {
      const lastLine = element.lastChild
      if (!lastLine || lastLine.nodeType !== Node.TEXT_NODE) {
        throw new Error("IDML second line text node is missing")
      }
      const range = element.ownerDocument.createRange()
      range.setStart(lastLine, lastLine.textContent?.length ?? 0)
      range.collapse(true)
      const rect = range.getClientRects()[0] ?? range.getBoundingClientRect()
      return { x: rect.left, y: rect.top + Math.max(1, rect.height / 2) }
    })

    await this.page.mouse.click(point.x, point.y)
    target = this.editableTarget(index)
    await expect(target).toBeVisible({ timeout: 10_000 })
    await expect(target).toBeFocused({ timeout: 10_000 })
    await expect.poll(() => target.evaluate((surface) => {
      const editor = (surface as HTMLElement & {
        editor?: { state: { selection: { $from: { parentOffset: number } } } }
      }).editor
      return editor?.state.selection.$from.parentOffset ?? -1
    })).toBe(7)

    await this.page.keyboard.type("q")
    await expect(target.locator('span[data-idml-slot="0"]')).toHaveText("abcxyzq")

    // Clear both protected slots and persist the untranslated state so this
    // regression probe cannot affect the artifact assertions later in the test.
    await this.page.keyboard.press("ControlOrMeta+A")
    await this.page.keyboard.press("Backspace")
    await this.commitTargetCellEdit(index, "")
    await expect(target).toBeHidden()
  }

  /**
   * AQU-740: a line break typed at the end of an IDML slot must keep a caret
   * line box. Without the synthetic trailing-break compensation the empty last
   * line had no height and the browser parked the visible cursor back at the
   * cell's first line. Types a draft with a break, asserts the compensation
   * and the extra line box, then deletes everything back so the cell ends
   * exactly as it started (untranslated, no commit).
   */
  async verifyIdmlTrailingBreakCaret(index: number): Promise<void> {
    const target = await this.activateTargetCell(index)
    await this.page.keyboard.type("xy")
    await expect(target).toContainText("xy")
    const paragraphHeight = () => target.evaluate((element) => {
      const paragraph = element.querySelector("p")
      if (!paragraph) throw new Error("IDML paragraph missing")
      return paragraph.getBoundingClientRect().height
    })
    const heightBefore = await paragraphHeight()

    await this.page.keyboard.press("Enter")
    await expect(target.locator(".idml-trailing-break")).toHaveCount(1)
    // The empty new line must own real height — that is the caret's line box.
    await expect.poll(paragraphHeight).toBeGreaterThan(heightBefore * 1.5)

    // The next character lands after the break and retires the compensation.
    await this.page.keyboard.type("z")
    await expect(target.locator(".idml-trailing-break")).toHaveCount(0)

    // x, y, break, z — four presses back to an untranslated cell.
    for (let press = 0; press < 4; press += 1) {
      await this.page.keyboard.press("Backspace")
    }
    await expect(target).toHaveText("")
    await expect(
      this.page.getByText(/This edit would remove protected InDesign formatting/i),
    ).toHaveCount(0)
    await this.page.keyboard.press("Escape")
    await expect(target).toBeHidden()
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
