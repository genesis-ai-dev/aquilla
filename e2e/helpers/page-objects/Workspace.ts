import { type Page, type Locator, expect } from "@playwright/test"

/** Page object for the project workspace route ("/project/:id"). */
export class Workspace {
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  async importFile(filePath: string): Promise<void> {
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
    // Retry once: right after a previous import, header re-renders can
    // swallow the click (the button is replaced mid-press), leaving no
    // dialog open and the next locator hanging for the full test budget.
    const uploadCard = this.page.getByText("Upload Files")
    await this.openImportDialog()
    if (!(await uploadCard.isVisible({ timeout: 3_000 }).catch(() => false))) {
      await this.openImportDialog()
    }
    // Navigate to the Upload Files panel by clicking its card.
    await uploadCard.click()
    // UploadPanel is now visible with a "Choose Files" button.
    // Prefer the import dialog's file picker — cell audio upload inputs also
    // match a bare `input[type=file]:not([webkitdirectory])` once the editor
    // has hydrated, which trips Playwright's strict mode.
    const chooseFilesBtn = this.page.getByRole("button", { name: /Choose Files/i })
    await expect(chooseFilesBtn).toBeVisible({ timeout: 5_000 })
    await chooseFilesBtn.locator('input[type="file"]').setInputFiles(filePath)
    // AQU-310: selecting a file now lands on a Preview panel (parsed cells +
    // counts) instead of starting the upload immediately. Confirm it to kick
    // off the actual bulk upload.
    const confirmBtn = this.page.getByRole("button", { name: /Confirm import/i })
    await expect(confirmBtn).toBeVisible({ timeout: 10_000 })
    await confirmBtn.click()
    // The upload runs ("Uploading…"), then the dialog closes on success.
    await expect(confirmBtn).not.toBeVisible({ timeout: 15_000 })
    // The dialog closing only means the upload was handed off — the sidebar
    // file list renders from the server projection, which lags the import by
    // a sync round-trip. Wait for an actual file row so callers can click it
    // immediately (every openFileBySubstring caller depends on this).
    await expect(
      this.page.locator("aside").locator('button[aria-label="File actions"]').first(),
    ).toBeVisible({ timeout: 15_000 })
  }

  private async openImportDialog(): Promise<void> {
    const banner = this.page.getByRole("banner")
    const moreActionsBtn = banner.getByRole("button", { name: /More actions/i })
    if (await moreActionsBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await moreActionsBtn.click()
      const importItem = this.page
        .getByRole("menuitem", { name: /^Import$/i })
        .filter({ visible: true })
        .last()
      await expect(importItem).toBeVisible({ timeout: 5_000 })
      await importItem.click()
      return
    }

    const directImportBtn = this.page.getByRole("button", { name: /^Import$/i }).filter({ visible: true }).first()
    await expect(directImportBtn).toBeVisible({ timeout: 10_000 })
    await directImportBtn.click()
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
   * AQU-538: the LaneSwitcher (`data-testid="lane-switcher"`) renders in the
   * workspace header ONLY when the project has a second target lane — see
   * `LaneSwitcher.tsx`. Options are `data-testid="lane-option-<tag>"`; the
   * default lane's tag is the empty string (`lane-option-`).
   */
  laneSwitcher(): Locator {
    return this.page.getByTestId("lane-switcher")
  }

  /** Switch the active target lane. Pass `""` for the default lane. */
  async switchLane(tag: string): Promise<void> {
    await expect(this.laneSwitcher()).toBeVisible({ timeout: 10_000 })
    const option = this.page.getByTestId(`lane-option-${tag}`)
    await option.click()
    await expect(option).toHaveAttribute("aria-checked", "true", { timeout: 5_000 })
  }

  /** Read the currently active lane's tag (`""` = default) off the switcher. */
  async readActiveLane(): Promise<string> {
    await expect(this.laneSwitcher()).toBeVisible({ timeout: 10_000 })
    const checked = this.laneSwitcher().locator('[role="radio"][aria-checked="true"]')
    const testId = await checked.getAttribute("data-testid")
    return testId?.replace(/^lane-option-/, "") ?? ""
  }
}
