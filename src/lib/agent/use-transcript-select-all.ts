/**
 * use-transcript-select-all.ts — Cmd/Ctrl+A inside the agent chat selects the
 * transcript, not the whole page (AQU-1652).
 *
 * The listener sits on the document rather than the transcript element because
 * clicking message text leaves focus on `<body>`: what says "the reader is in
 * the transcript" is the selection anchor as much as the focused node. A text
 * entry (the composer, a rename field) keeps the browser's own Select All, so
 * this never steals the shortcut from somewhere it belongs.
 */

import { useEffect, type RefObject } from "react"

function isTextEntry(node: EventTarget | null): boolean {
  if (!(node instanceof HTMLElement)) return false
  if (node.isContentEditable) return true
  const tag = node.tagName
  return tag === "INPUT" || tag === "TEXTAREA"
}

function within(root: HTMLElement, node: Node | null | undefined): boolean {
  return node != null && node !== root.ownerDocument?.body && root.contains(node)
}

export function useTranscriptSelectAll(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "a" && event.key !== "A") return
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const root = ref.current
      if (!root || isTextEntry(event.target)) return
      const selection = root.ownerDocument.defaultView?.getSelection() ?? null
      const anchored =
        within(root, event.target as Node | null) || within(root, selection?.anchorNode)
      if (!anchored || !selection) return
      event.preventDefault()
      const range = root.ownerDocument.createRange()
      range.selectNodeContents(root)
      selection.removeAllRanges()
      selection.addRange(range)
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [ref])
}
