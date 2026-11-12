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
  /**
   * The one take this controller plays, when it plays one ("file|audioId").
   * Every waveform of that take then shows ONE playback — whichever copy
   * started it — and stops it (Sam, 2026-09-29: the Audio view card and the
   * Recording tab below it were two players, and "stop" on one started it
   * again from the top over the other).
   */
  clipKey?: () => string | null
  /** Where that take is, in seconds — for the copies that mirror it. */
  currentTime?: () => number
  /** Move that take's playhead — a copy's scrub moves the one playback. */
  seek?: (t: number) => void
}

let current: ActiveAudioController | null = null
const listeners = new Set<() => void>()

function notify() { for (const l of listeners) l() }

/** The active controller started, paused or ended: copies of the same take
 *  that mirror it (see `clipKey`) re-read its state. */
export function notifyActiveAudioChanged(): void { notify() }

/** The last-used copy of THIS take, when it is another one than `self` —
 *  playing or paused. Play and seek on any copy go to it, so the take keeps
 *  ONE playback that resumes where it was left, whichever copy is pressed. */
export function otherCopyOf(self: ActiveAudioController, clipKey: string | null): ActiveAudioController | null {
  const c = current
  if (!c || c === self || !clipKey) return null
  return c.clipKey?.() === clipKey ? c : null
}

/** Another controller is sounding THIS take, `self` being one of its copies. */
export function playingElsewhere(self: ActiveAudioController, clipKey: string | null): ActiveAudioController | null {
  const c = current
  if (!c || c === self || !clipKey) return null
  return c.clipKey?.() === clipKey && c.isPlaying() ? c : null
}

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
 * Become the active audio AND silence whatever was playing before. (AQU-1217)
 *
 * `setActiveAudio` only records who owns the Space shortcut; it deliberately
 * does not pause the previous holder. Where two players sit side by side and
 * only one may sound — the recorder's selected-take waveform and a Takes-row
 * audition — each claims the floor through this instead.
 */
export function claimActiveAudio(controller: ActiveAudioController): void {
  const previous = current
  if (previous && previous !== controller && previous.isPlaying()) previous.pause()
  setActiveAudio(controller)
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
// FORTIFY: "base" claims sit BELOW every normal claim regardless of MOUNT
// ORDER. The playback bar claims at mount so the global last-clip handler
// stands down while the bar is on screen — but in the media lens the bar
// mounts after the timeline, and a single mount-ordered stack hoisted it
// above the timeline, silently taking Space (and standing the timeline's
// Cmd+Enter down) from the surface designed to own it. Tiers make the
// designed order (bar < timeline < recording modal) hold structurally.
const baseShortcutOwners: AudioShortcutOwner[] = []

/** Claim the audio shortcuts. Returns a release fn; the token identifies you.
 *  `tier: "base"` yields to every normal claim (the playback bar). */
export function pushAudioShortcutOverride(
  tier: "normal" | "base" = "normal",
): (() => void) & { owner: AudioShortcutOwner } {
  const owner = nextShortcutOwner++
  const list = tier === "base" ? baseShortcutOwners : shortcutOwners
  list.push(owner)
  let released = false
  const release = () => {
    if (released) return
    released = true
    const i = list.lastIndexOf(owner)
    if (i !== -1) list.splice(i, 1)
  }
  return Object.assign(release, { owner })
}

export function isAudioShortcutOverridden(): boolean {
  return shortcutOwners.length > 0 || baseShortcutOwners.length > 0
}

/**
 * True when `owner` is the innermost claim — i.e. nothing has claimed the
 * shortcuts on top of it. A long-lived claimant (the timeline) checks this so
 * a modal opened above it takes over cleanly and gets them back on close.
 * Base-tier claimants are top only while NO normal claim exists.
 */
export function isTopAudioShortcutOwner(owner: AudioShortcutOwner): boolean {
  if (shortcutOwners.length > 0) return shortcutOwners[shortcutOwners.length - 1] === owner
  return baseShortcutOwners.length > 0 && baseShortcutOwners[baseShortcutOwners.length - 1] === owner
}

/** Test seam — drop any leftover overrides between tests. */
export function __resetAudioShortcutOverridesForTests(): void {
  shortcutOwners.length = 0
  baseShortcutOwners.length = 0
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
