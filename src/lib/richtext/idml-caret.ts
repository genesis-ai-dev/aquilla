export type IdmlPointerSelection =
  | { kind: "slot"; slot: number; offset: number }
  | { kind: "plain"; offset: number }

type CaretPointDocument = Document & {
  caretRangeFromPoint?: (x: number, y: number) => Range | null
}

/**
 * Capture the browser's text position while the inexpensive read surface is
 * still mounted. Activating a row replaces that DOM with ProseMirror, so the
 * slot identity and text offset are the durable bridge across the remount.
 */
export function idmlPointerSelectionFromPoint(
  event: Pick<MouseEvent, "clientX" | "clientY" | "target">,
  readRoot?: HTMLElement | null,
): IdmlPointerSelection | null {
  const target = event.target instanceof HTMLElement
    ? event.target.closest<HTMLElement>("[data-idml-slot]")
    : null
  if (target?.getAttribute("contenteditable") === "false") return null
  const root = target ?? readRoot
  if (!root) return null

  const doc = root.ownerDocument as CaretPointDocument
  const caret = doc.caretPositionFromPoint?.(event.clientX, event.clientY)
  const range = caret
    ? (() => {
        const next = doc.createRange()
        next.setStart(caret.offsetNode, caret.offset)
        next.collapse(true)
        return next
      })()
    : doc.caretRangeFromPoint?.(event.clientX, event.clientY) ?? null
  if (!range || !root.contains(range.startContainer)) return null

  const prefix = doc.createRange()
  prefix.selectNodeContents(root)
  prefix.setEnd(range.startContainer, range.startOffset)
  const offset = prefix.toString().length
  if (!target) return { kind: "plain", offset }

  const slot = Number(target.getAttribute("data-idml-slot"))
  return Number.isSafeInteger(slot) ? { kind: "slot", slot, offset } : null
}
