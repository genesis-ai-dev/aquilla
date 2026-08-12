// Keyboard affordance for the Audio-lens playback bar: the spacebar toggles
// play/pause on the global transport. Extracted as a pure predicate so the
// "don't hijack Space while the user is typing or on a focused control" rule
// is unit-testable without a live DOM.

/** Minimal shape of a keydown we need — a real `KeyboardEvent` satisfies it,
 *  and tests can pass a plain object. */
export interface PlaybackKeyEvent {
  code?: string
  key?: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  target: EventTarget | null
}

/** Elements for which Space already has its own meaning — typing into a field
 *  or activating a focused control — so the transport must NOT steal the key. */
function isInteractiveOrEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  const el = target as HTMLElement
  if (el.isContentEditable) return true // the TipTap editor, comment boxes, …
  switch (el.tagName) {
    case "INPUT":
    case "TEXTAREA":
    case "SELECT":
    case "AUDIO":
    case "VIDEO":
      return true
    case "BUTTON":
      // Real buttons refuse Space (it activates them natively) — except
      // transport surfaces that opt in: timeline dub CHIPS are buttons whose
      // "activation" is selection, already done by the click that focused
      // them, so click-a-chip-then-Space must play, not go dead. The check is
      // OWN-attribute (never closest): a control nested INSIDE an opted-in
      // surface — the chip's corner record button — keeps its native Space.
      return !el.hasAttribute?.("data-spacebar-transport")
  }
  switch (el.getAttribute?.("role")) {
    case "button":
      // role="button" DIVs fork the same two ways: dialog dropzones and voice
      // cards are real controls (refuse), but timeline cards opt in with
      // data-spacebar-transport so click-a-verse-then-Space plays.
      return !el.hasAttribute?.("data-spacebar-transport")
    case "textbox":
    case "slider":
    case "menuitem":
      return true
  }
  return false
}

/**
 * True when a keydown should toggle transport play/pause: the space bar, with
 * no modifier held, and focus not on an editable/interactive element (so typing
 * a space in the editor or pressing a focused button keeps its normal effect).
 */
export function spacebarShouldToggle(e: PlaybackKeyEvent): boolean {
  if (e.code !== "Space" && e.key !== " " && e.key !== "Spacebar") return false
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false
  return !isInteractiveOrEditable(e.target)
}
