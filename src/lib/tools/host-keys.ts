/**
 * Smart Extensions: focus handoff for app shortcuts (apiRev 2).
 *
 * Keyboard events inside a sandboxed frame never reach the app, so Ctrl/Cmd+K
 * (search), Ctrl/Cmd+Shift+E (extensions palette) and friends would be dead
 * while an extension editor has focus. The host lists the chords it owns in
 * the boot data; the runtime forwards exactly those (`ui.hostKey`) and the
 * host replays them on its own document. Nothing else crosses: an extension
 * cannot synthesize arbitrary keystrokes into the app.
 */

import type { HostKey } from "./host-handlers"

/** Chords the app handles at document/window level (see ProjectWorkspace's
 *  search/replace handler and ExtensionsBar's palette handler). */
export const HOST_SHORTCUTS: readonly string[] = [
  "mod+k",
  "mod+f",
  "mod+shift+f",
  "mod+shift+k",
  "mod+shift+r",
  "mod+shift+e",
]

export function chordOf(k: HostKey): string {
  return `${k.mod ? "mod+" : ""}${k.shift ? "shift+" : ""}${k.alt ? "alt+" : ""}${k.key.toLowerCase()}`
}

export function isHostShortcut(k: HostKey): boolean {
  return HOST_SHORTCUTS.includes(chordOf(k))
}

function isMac(): boolean {
  return typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent)
}

/** Replay an allowlisted chord on the host document. Returns whether it was
 *  allowlisted (and so dispatched). */
export function dispatchHostKey(k: HostKey, doc: Document = document): boolean {
  if (!isHostShortcut(k)) return false
  const mac = isMac()
  doc.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: k.key,
      ctrlKey: k.mod && !mac,
      metaKey: k.mod && mac,
      shiftKey: k.shift,
      altKey: k.alt,
      bubbles: true,
      cancelable: true,
    }),
  )
  return true
}
