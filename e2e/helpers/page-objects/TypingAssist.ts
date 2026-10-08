import { expect, type Locator, type Page } from "@playwright/test"
import type { Workspace } from "./Workspace"

/**
 * The target editor's typing aids: BIA ghost-text suggestions at the caret
 * and the "words that fit here" thesaurus on a selected word.
 *
 * Cells are addressed by id, not row index: the editor table is virtualized,
 * so a row far down the file is not in the DOM until it is scrolled to.
 */
export class TypingAssist {
  private readonly page: Page
  private readonly ws: Workspace

  constructor(page: Page, ws: Workspace) {
    this.page = page
    this.ws = ws
  }

  private target(cellId: string): Locator {
    return this.page.locator(`[data-cell-id="${cellId}"] [data-cell-type="target"]`).first()
  }

  /** The cell's mounted rich-text editor. */
  editor(cellId: string): Locator {
    return this.target(cellId).locator('.ProseMirror[contenteditable="true"]').first()
  }

  /**
   * The editor's DOCUMENT text. Not the DOM's text: the ghost suggestion is a
   * widget inside the contenteditable, so `toHaveText` on the editor would
   * read it too — which is exactly what must never reach the document.
   */
  async documentText(cellId: string): Promise<string> {
    return this.editor(cellId).evaluate((el) => (el as HTMLElement & { editor: { getText: () => string } }).editor.getText())
  }

  /** The faint suggestion shown after the caret. */
  ghost(cellId: string): Locator {
    return this.editor(cellId).getByTestId("ghost-text")
  }

  /** "Next unfinished" scrolls to the first untranslated cell and focuses its editor. */
  async openNextUnfinished(cellId: string): Promise<Locator> {
    await this.ws.jumpNextUnfinished()
    const editor = this.editor(cellId)
    await expect(editor).toBeFocused({ timeout: 30_000 })
    return editor
  }

  async type(text: string, delay = 0): Promise<void> {
    await this.page.keyboard.type(text, { delay })
  }

  /** Tab: accept the whole suggestion. */
  async acceptSuggestion(): Promise<void> {
    await this.page.keyboard.press("Tab")
  }

  /** →: accept just the next word of the suggestion. */
  async acceptNextWord(): Promise<void> {
    await this.page.keyboard.press("ArrowRight")
  }

  async dismissSuggestion(): Promise<void> {
    await this.page.keyboard.press("Escape")
  }

  /** Double-click the `nth` occurrence of `word` in the cell's editor. */
  async selectWord(cellId: string, word: string, nth = 0): Promise<void> {
    const box = await this.editor(cellId).evaluate((root, args) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let seen = 0
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? ""
        for (let at = text.indexOf(args.word); at >= 0; at = text.indexOf(args.word, at + 1)) {
          if (seen++ !== args.nth) continue
          const range = document.createRange()
          range.setStart(node, at)
          range.setEnd(node, at + args.word.length)
          const rect = range.getBoundingClientRect()
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        }
      }
      return null
    }, { word, nth })
    if (!box) throw new Error(`"${word}" (#${nth}) not found in cell ${cellId}`)
    await this.page.mouse.dblclick(box.x, box.y)
  }

  wordsThatFitButton(): Locator {
    return this.page.getByTestId("words-that-fit-button")
  }

  async openWordsThatFit(): Promise<Locator> {
    await this.wordsThatFitButton().click()
    const panel = this.page.getByTestId("words-that-fit-panel")
    await expect(panel).toBeVisible()
    return panel
  }

  /** Click the chip that replaces the selection with `word`. */
  async replaceWith(word: string): Promise<void> {
    await this.page.getByTestId("words-that-fit-panel").getByRole("button", { name: `Replace with ${word}` }).click()
  }
}
