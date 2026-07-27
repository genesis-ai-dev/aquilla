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
// shortcuts (Space, arrows). The global handler bails while anything holds a
// claim, so the claiming UI (e.g. the recording modal) gets Space to itself.
//
// SUB-52: this used to be a bare counter, which could say "somebody claimed
// this" but never "who". The media timeline claims Space for its transport for
// as long as it is mounted, and the recording modal opens ON TOP of it without
// unmounting it — so Space both toggled recording and started the timeline
// playing underneath. Tracking owners in order lets a claimant ask whether it
// is still the innermost one and stand down if it isn't.
export type AudioShortcutOwner = number

let nextShortcutOwner: AudioShortcutOwner = 1
const shortcutOwners: AudioShortcutOwner[] = []

/** Claim the audio shortcuts. Returns a release fn; the token identifies you. */
export function pushAudioShortcutOverride(): (() => void) & { owner: AudioShortcutOwner } {
  const owner = nextShortcutOwner++
  shortcutOwners.push(owner)
  let released = false
  const release = () => {
    if (released) return
    released = true
    const i = shortcutOwners.lastIndexOf(owner)
    if (i !== -1) shortcutOwners.splice(i, 1)
  }
  return Object.assign(release, { owner })
}

export function isAudioShortcutOverridden(): boolean {
  return shortcutOwners.length > 0
}

/**
 * True when `owner` is the innermost claim — i.e. nothing has claimed the
 * shortcuts on top of it. A long-lived claimant (the timeline) checks this so
 * a modal opened above it takes over cleanly and gets them back on close.
 */
export function isTopAudioShortcutOwner(owner: AudioShortcutOwner): boolean {
  return shortcutOwners.length > 0 && shortcutOwners[shortcutOwners.length - 1] === owner
}

/** Test seam — drop any leftover overrides between tests. */
export function __resetAudioShortcutOverridesForTests(): void {
  shortcutOwners.length = 0
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
