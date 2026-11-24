/** Command-A or Control-A, and not a shifted or alternate chord. */
export function isCellSelectAllKey(event: {
  key: string
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}): boolean {
  if (event.altKey || event.shiftKey) return false
  if (!event.metaKey && !event.ctrlKey) return false
  return event.key.toLowerCase() === "a" || event.code === "KeyA"
}

function isTextArea(node: EventTarget | Element | null): boolean {
  if (!(node instanceof Element)) return false
  return Boolean(node.closest("input, textarea, select, [contenteditable='true']"))
}

/** The text pane is folded, parked, or sitting behind another tab. */
function textPaneIsOpen(root: HTMLElement): boolean {
  const host = root.closest("[data-media-panel='text']")
  if (!(host instanceof HTMLElement)) return true
  if (host.hidden || host.inert) return false
  return host.style.visibility !== "hidden"
}

/**
 * Command-A checks the cells when the text pane is open and the key is not
 * going to a text field. Typing in a cell, or in any other text area, still
 * selects that text.
 */
export function claimsCellSelectAll(root: HTMLElement, event: KeyboardEvent): boolean {
  if (!isCellSelectAllKey(event)) return false
  if (!textPaneIsOpen(root)) return false
  const active = root.ownerDocument.activeElement
  if (isTextArea(active) || isTextArea(event.target instanceof Node ? event.target : null)) return false
  const pane = root.closest("[data-media-panel='text']") ?? root
  if (
    active instanceof Element
    && active !== root.ownerDocument.body
    && active !== root.ownerDocument.documentElement
    && !pane.contains(active)
  ) return false
  return true
}
