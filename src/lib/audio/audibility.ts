// Which tracks are audible, and who is allowed to say so. (AQU-646 stage 2)
//
// Round 5 kept this inside TimelineEditor: component state, persisted to
// localStorage, pushed into the play queue by an effect. That was sound while
// the editor was the only surface with a mute button on it. Stage 2 moves the
// source mute onto the video pane's header — the film's own soundtrack is what
// it silences, and the timeline's rows are cue data now — which leaves TWO
// components able to write the same preference. Two writers each merging a
// toggle into their OWN copy of the state clobber each other: the pane mutes
// the film, the editor re-publishes the value IT still believes in, and the
// film comes back on.
//
// So the play-queue store is the single source of truth, and this module is the
// only thing that writes it. Every button reads `useQueueAudibility()` and
// flips through `toggleAudibility`, which merges against the store rather than
// against whatever the caller happens to be holding.

import {
  getQueueAudibility,
  setQueueAudibility,
  useQueueAudibility,
  type TrackAudibility,
} from "@/lib/audio/play-queue"
import { activeSolo, isDefaultTrackSlot, sourceHeard } from "@/lib/timeline/track-slots"

// Re-exported so both buttons — the timeline's lane gutter and the video pane's
// header — reach audibility through exactly one module.
export { sourceHeard, useQueueAudibility }
export type { TrackAudibility }

/** Persisted per file, like zoom. The key is MOVED VERBATIM from TimelineEditor
 *  (round 5) so every preference already written to disk survives the move. */
export const audibilityKey = (fileId: string) => `aquilla:timelineAudibility:${fileId}`

/** Both tracks on unless the stored value explicitly says otherwise, and both
 *  on for anything unreadable — a mute preference is not worth failing a render
 *  over, and private mode has no storage to read at all. */
export function loadAudibility(fileId: string): TrackAudibility {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(audibilityKey(fileId)) ?? "")
    if (parsed && typeof parsed === "object") {
      const p = parsed as Partial<TrackAudibility>
      // AQU-646 stage 3: added tracks ride a slot-keyed map, read with the same
      // `!== false` default-on rule the two named flags use — so a brand-new
      // track is audible without anybody opting in, and a flag can only be
      // there because somebody switched it off. Every preference already on
      // disk parses unchanged: it simply has no `bySlot`.
      const bySlot =
        p.bySlot && typeof p.bySlot === "object" && !Array.isArray(p.bySlot)
          ? Object.fromEntries(
              Object.entries(p.bySlot).filter(([, v]) => typeof v === "boolean"),
            )
          : undefined
      // AQU-2664: the tracks played alone, kept with the mutes.
      const solo = Array.isArray(p.solo) ? p.solo.filter((v): v is string => typeof v === "string") : []
      return {
        source: p.source !== false,
        target: p.target !== false,
        ...(bySlot && Object.keys(bySlot).length > 0 ? { bySlot } : {}),
        ...(solo.length > 0 ? { solo } : {}),
      }
    }
  } catch {
    /* unset / private mode */
  }
  return { source: true, target: true }
}

function persist(fileId: string, value: TrackAudibility): void {
  try {
    // Which rows are drawn is this moment's, not a preference.
    const { drawn: _drawn, ...kept } = value
    void _drawn
    localStorage.setItem(audibilityKey(fileId), JSON.stringify(kept))
  } catch {
    /* private mode — just won't persist */
  }
}

/**
 * Publish a file's persisted preference into the store.
 *
 * Idempotent by construction — the same file always yields the same value — so
 * the editor and the pane both calling it is one publish and one harmless
 * re-publish, whichever mounts first.
 *
 * Call it from a `[fileId]` effect and nowhere else. Seeding on any other
 * dependency (or per render) would re-read the value on disk and stamp out a
 * toggle made this session, because a toggle publishes before it persists is
 * visible and the disk copy is only ever the file's STARTING point.
 */
export function seedAudibility(fileId: string): void {
  // The drawn rows are the timeline's to say (review M4), not the disk's: keep
  // what it last said; it says it again whenever its rows change.
  const drawn = getQueueAudibility().drawn
  setQueueAudibility({ ...loadAudibility(fileId), ...(drawn ? { drawn } : {}) })
}

/**
 * WHICH FLAG A ROW'S SPEAKER ADDRESSES. (AQU-646 stage 6A)
 *
 * THE WRITER AND THE READER MUST BOTH COME THROUGH HERE, and the reason is a
 * bug that shipped: `toggleAudibility` classified `"target"` as the target
 * flag while the gutter button read its state back through `slotAudible`,
 * which knows only real SLOTS — so `"target"` fell through to `bySlot`, a map
 * nothing ever writes that key into, and the button reported "audible"
 * forever. Every click genuinely muted or unmuted the row while the icon never
 * moved, so the natural second click silently undid the first (Sam,
 * 2026-08-27: "you can't mute and unmute the audio target track").
 *
 * `slotAudible` is NOT the thing to reuse here. It answers for real slots —
 * which is exactly right for the queue's overlay sweep, where every entry
 * carries one — but the derived row's `audibilityKey` is the bare word
 * `"target"`, which is not a slot at all. This function is the one that speaks
 * both languages.
 */
type AudibilityTarget = "source" | "target" | "slot"

function audibilityTargetFor(slotOrTrack: string): AudibilityTarget {
  if (slotOrTrack === "source") return "source"
  // The default row answers to `target` under any of its names: the row's own
  // `audibilityKey`, or either of the two legacy slots it stores takes in.
  if (slotOrTrack === "target" || isDefaultTrackSlot(slotOrTrack)) return "target"
  return "slot"
}

/**
 * Is this row's audio on?
 *
 * Takes whatever a gutter row calls itself — `"source"`, `"target"`, a default
 * slot, or an added track's id — and answers from the flag `toggleAudibility`
 * would flip for that same string. ABSENT MEANS AUDIBLE, the rule every layer
 * here uses: a brand-new track is heard without anybody opting in.
 */
export function trackAudible(state: TrackAudibility, slotOrTrack: string): boolean {
  switch (audibilityTargetFor(slotOrTrack)) {
    case "source":
      return state.source !== false
    case "target":
      return state.target !== false
    default:
      return state.bySlot?.[slotOrTrack] !== false
  }
}

/**
 * Flip one track's audio for one file: persist first, then publish.
 *
 * TAKES A SLOT, not a `keyof TrackAudibility`. (AQU-646 stage 3) The two named
 * flags are still named — `"source"` and the default row's `"recording"` /
 * `"generatedVoice"` both mean `target` — and every added track addresses its
 * own flag by its slot.
 *
 * The merge base is `getQueueAudibility()` — the store — never a caller's own
 * state. That is the entire reason this module exists: with two buttons live,
 * merging from either one's local copy silently drops the other's toggle. And
 * the flag it flips is chosen by `audibilityTargetFor`, the same classifier
 * `trackAudible` reads back through, so the two can never disagree again.
 */
export function toggleAudibility(fileId: string, slotOrTrack: string): void {
  const current = getQueueAudibility()
  const audible = trackAudible(current, slotOrTrack)
  const next: TrackAudibility = (() => {
    switch (audibilityTargetFor(slotOrTrack)) {
      case "source":
        return { ...current, source: !audible }
      case "target":
        return { ...current, target: !audible }
      default:
        return { ...current, bySlot: { ...current.bySlot, [slotOrTrack]: !audible } }
    }
  })()
  persist(fileId, next)
  setQueueAudibility(next)
}

/** The one name a row is soloed under: "source", "target" (the default row,
 *  under any of its names) or an added track's slot. */
function soloKeyFor(slotOrTrack: string): string {
  const kind = audibilityTargetFor(slotOrTrack)
  return kind === "slot" ? slotOrTrack : kind
}

/** AQU-2664 (board 74): is this row played alone (its S lit)? */
export function trackSoloed(state: TrackAudibility, slotOrTrack: string): boolean {
  return state.solo?.includes(soloKeyFor(slotOrTrack)) ?? false
}

/** AQU-2664: is this row heard right now — not muted, and not quiet because
 *  another row is soloed? Its own M is `trackAudible`, which solo never moves. */
export function trackHeard(state: TrackAudibility, slotOrTrack: string): boolean {
  if (!trackAudible(state, slotOrTrack)) return false
  const solo = activeSolo(state)
  return solo.length === 0 || solo.includes(soloKeyFor(slotOrTrack))
}

/**
 * Review M4: which rows are drawn now, by their audibility keys ("source",
 * "target", an added track's slot). The timeline publishes it whenever its
 * rows change; solo entries for any other row are ignored, so a soloed track
 * that is deleted or hidden never silences the rest.
 */
export function setDrawnRows(keys: readonly string[]): void {
  const current = getQueueAudibility()
  const next = [...new Set(keys.map(soloKeyFor))].sort()
  if (current.drawn && current.drawn.length === next.length && current.drawn.every((k, i) => k === next[i])) return
  setQueueAudibility({ ...current, drawn: next })
}

/** AQU-2664: solo or unsolo one row for one file: persist, then publish
 *  (merged against the store, like `toggleAudibility`). */
export function toggleSolo(fileId: string, slotOrTrack: string): void {
  const current = getQueueAudibility()
  const key = soloKeyFor(slotOrTrack)
  const solo = current.solo ?? []
  const nextSolo = solo.includes(key) ? solo.filter((k) => k !== key) : [...solo, key]
  const next: TrackAudibility = { ...current, solo: nextSolo }
  if (nextSolo.length === 0) delete next.solo
  persist(fileId, next)
  setQueueAudibility(next)
}
