// Singleton "currently active audio" coordinator. Tracks the controller that
// the user most recently played from so global affordances (the keyboard
// space shortcut, future "scroll to playing cell" jumps) have a single,
// well-defined target.
//
// Each useCellAudio instance registers a small delegating object that reads
// from refs (so the coordinator always sees live play/pause state, not a
// React render-time snapshot).

export interface ActiveAudioController {
  /** Returns true if audio is currently playing. Reads live, not a snapshot. */
  isPlaying: () => boolean
  play: () => Promise<void>
  pause: () => void
}

let current: ActiveAudioController | null = null
const listeners = new Set<() => void>()

function notify() { for (const l of listeners) l() }

export function setActiveAudio(controller: ActiveAudioController): void {
  if (current === controller) return
  current = controller
  notify()
}

export function clearActiveAudioIf(controller: ActiveAudioController): void {
  if (current === controller) {
    current = null
    notify()
  }
}

export function getActiveAudio(): ActiveAudioController | null {
  return current
}

/**
 * Toggle the current active audio. Returns true if a controller was found and
 * acted on, false if there's nothing playable yet.
 */
export function togglePlayActive(): boolean {
  const c = current
  if (!c) return false
  if (c.isPlaying()) c.pause()
  else void c.play()
  return true
}

export function subscribeActiveAudio(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

// Stack of components that have temporarily claimed the audio keyboard
// shortcuts (Space, arrows). The global handler bails when this is > 0 so the
// claiming UI (e.g. the recording modal) gets exclusive Space handling.
let shortcutOverrideCount = 0

export function pushAudioShortcutOverride(): () => void {
  shortcutOverrideCount += 1
  let released = false
  return () => {
    if (released) return
    released = true
    shortcutOverrideCount = Math.max(0, shortcutOverrideCount - 1)
  }
}

export function isAudioShortcutOverridden(): boolean {
  return shortcutOverrideCount > 0
}

/** Test seam — drop any leftover overrides between tests. */
export function __resetAudioShortcutOverridesForTests(): void {
  shortcutOverrideCount = 0
}

/**
 * True when the keyboard event happened inside an editable surface where
 * Space (or other keys) should keep their default insert-text behavior.
 */
export function isInEditableContext(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true
  if (target.isContentEditable) return true
  // ProseMirror's editor root is contentEditable=true; descendants inherit
  // that property check above. Defensive against custom attribute quirks:
  if (target.closest('[contenteditable="true"]')) return true
  return false
}
