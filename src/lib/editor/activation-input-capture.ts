/**
 * AQU-1333: capture text that arrives during the target-cell activation window.
 *
 * Activating a target cell is asynchronous: the static read surface is swapped
 * for a freshly mounted `TranslatedEditor`, which only takes focus a frame or
 * two later (~300 ms to mount, ~500 ms to focus on a busy table). AQU-746
 * already buffers plain `keydown` on the row wrapper during that window and
 * replays it once the editor focuses, so a fast typist never loses a character.
 *
 * Keyboard is not the only way text enters a cell. CDP `Input.insertText` (how
 * browser agents and Playwright's `fill`/`insertText` type), IME composition,
 * OS dictation and paste all deliver text WITHOUT a `keydown`, so none of them
 * were buffered — the text appeared on screen, never reached the outbox, and
 * was gone after a reload. Worse, those paths need an *editing host* to fire at
 * all: the row wrapper is a plain `<div tabindex=0>`, so `beforeinput` and
 * composition events never even reached it.
 *
 * So for the length of the window this module makes the row wrapper a real
 * editing host and harvests what lands in it:
 *
 * - The caret is parked in a zero-size, `aria-hidden` capture element, so any
 *   text the browser inserts before we can stop it lands in a throwaway node
 *   rather than in React-owned row DOM. Its contents are wiped on every drain.
 * - Cancelable `beforeinput` and `paste` are prevented outright — nothing is
 *   mutated, the text goes straight to the buffer.
 * - IME composition cannot be cancelled (`insertCompositionText` is not
 *   cancelable), so intermediate composition events are ignored and the final
 *   `compositionend` data is buffered once. That keeps "ni" → "nih" from
 *   arriving as "nnini h".
 *
 * The caller owns the buffer (it is the same `pendingInputRef` the editor
 * drains on focus) — this module only reports text as it arrives, and undoes
 * every DOM change it made when `close()` is called.
 */

/** `beforeinput` types that carry text we want to keep. */
const TEXT_INPUT_TYPES = new Set([
  "insertText",
  "insertReplacementText",
  "insertFromPaste",
  "insertFromPasteAsQuotation",
  "insertFromDrop",
  "insertFromYank",
  "insertTranspose",
])

/** `beforeinput` types produced by an in-flight IME composition. */
const COMPOSITION_INPUT_TYPES = new Set([
  "insertCompositionText",
  "insertFromComposition",
  "deleteCompositionText",
  "deleteByComposition",
])

export interface ActivationInputCaptureOptions {
  /** The focused row wrapper. Becomes an editing host until `close()`. */
  host: HTMLElement
  /** Zero-size node inside `host` that holds the caret and absorbs stray text. */
  caretHost: HTMLElement
  /** Called with each chunk of text as it arrives, in order. */
  onText: (text: string) => void
}

export interface ActivationInputCapture {
  /** Restore the host and stop capturing. Safe to call more than once. */
  close: () => void
}

/**
 * Make `host` an editing host and start capturing non-keydown text input.
 *
 * `keydown` is deliberately NOT handled here: the row's own handler already
 * buffers printable keys and calls `preventDefault()`, which stops the matching
 * `beforeinput` from ever firing, so the two paths cannot double-count.
 */
export function openActivationInputCapture({
  host,
  caretHost,
  onText,
}: ActivationInputCaptureOptions): ActivationInputCapture {
  const previousContentEditable = host.getAttribute("contenteditable")
  const previousCaretColor = host.style.caretColor

  // `plaintext-only` keeps the browser from offering rich-text editing of the
  // row's own markup. Firefox only shipped it recently, so fall back to `true`
  // when the value did not take.
  host.setAttribute("contenteditable", "plaintext-only")
  if (host.isContentEditable === false) host.setAttribute("contenteditable", "true")
  // The editor is about to appear and own the caret; a blinking caret in the
  // row for ~300 ms would read as a second, competing insertion point.
  host.style.caretColor = "transparent"

  parkCaret(caretHost)

  let composing = false
  let closed = false

  /** Take whatever the browser managed to insert, then reset the throwaway node. */
  const drainCaretHost = () => {
    if (caretHost.textContent) caretHost.textContent = ""
  }

  const emit = (text: string) => {
    if (text) onText(text)
  }

  const handleBeforeInput = (event: InputEvent) => {
    if (COMPOSITION_INPUT_TYPES.has(event.inputType) || composing) return
    // Cancel every insertion we can, text-bearing or not: nothing should reach
    // the row's DOM, and a delete in an empty capture node has nothing to do.
    if (event.cancelable) event.preventDefault()
    if (!TEXT_INPUT_TYPES.has(event.inputType)) return
    const text = event.data ?? event.dataTransfer?.getData("text/plain") ?? ""
    emit(text)
    if (!event.cancelable) drainCaretHost()
  }

  const handlePaste = (event: ClipboardEvent) => {
    event.preventDefault()
    emit(event.clipboardData?.getData("text/plain") ?? "")
  }

  const handleCompositionStart = () => {
    composing = true
  }

  const handleCompositionEnd = (event: CompositionEvent) => {
    composing = false
    // Only the committed string, once — the intermediate `beforeinput` events
    // carry successive prefixes of it and were skipped above.
    emit(event.data ?? "")
    drainCaretHost()
  }

  host.addEventListener("beforeinput", handleBeforeInput as EventListener)
  host.addEventListener("paste", handlePaste as EventListener)
  host.addEventListener("compositionstart", handleCompositionStart)
  host.addEventListener("compositionend", handleCompositionEnd as EventListener)

  return {
    close: () => {
      if (closed) return
      closed = true
      host.removeEventListener("beforeinput", handleBeforeInput as EventListener)
      host.removeEventListener("paste", handlePaste as EventListener)
      host.removeEventListener("compositionstart", handleCompositionStart)
      host.removeEventListener("compositionend", handleCompositionEnd as EventListener)
      if (previousContentEditable === null) host.removeAttribute("contenteditable")
      else host.setAttribute("contenteditable", previousContentEditable)
      host.style.caretColor = previousCaretColor
      drainCaretHost()
    },
  }
}

/**
 * Collapse the selection into `caretHost`.
 *
 * Without this the browser drops the caret at the first editable position in
 * the row — inside React-rendered content — and an uncancelable composition
 * would splice text into DOM React believes it owns.
 */
function parkCaret(caretHost: HTMLElement): void {
  const selection = caretHost.ownerDocument.defaultView?.getSelection?.()
  if (!selection) return
  try {
    const range = caretHost.ownerDocument.createRange()
    range.selectNodeContents(caretHost)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
  } catch {
    // Selection APIs are partial in some test environments and headless
    // browsers. Losing the caret park only weakens the IME guard; every
    // cancelable path still buffers correctly, so this is not worth throwing.
  }
}
