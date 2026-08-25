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
import { isDefaultTrackSlot, slotAudible } from "@/lib/timeline/track-slots"

// Re-exported so both buttons — the timeline's lane gutter and the video pane's
// header — reach audibility through exactly one module.
export { useQueueAudibility }
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
      return {
        source: p.source !== false,
        target: p.target !== false,
        ...(bySlot && Object.keys(bySlot).length > 0 ? { bySlot } : {}),
      }
    }
  } catch {
    /* unset / private mode */
  }
  return { source: true, target: true }
}

function persist(fileId: string, value: TrackAudibility): void {
  try {
    localStorage.setItem(audibilityKey(fileId), JSON.stringify(value))
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
  setQueueAudibility(loadAudibility(fileId))
}

/**
 * Flip one track for one file: persist first, then publish.
 *
 * The merge base is `getQueueAudibility()` — the store — never a caller's own
 * state. That is the entire reason this module exists: with two buttons live,
 * merging from either one's local copy silently drops the other's toggle.
 */
/**
 * Flip one track's audio.
 *
 * TAKES A SLOT, not a `keyof TrackAudibility`. (AQU-646 stage 3) The two named
 * flags are still named — `"source"` and the default row's `"recording"` /
 * `"generatedVoice"` both mean `target` — and every added track addresses its
 * own flag by its slot.
 */
export function toggleAudibility(fileId: string, slotOrTrack: string): void {
  const current = getQueueAudibility()
  const next: TrackAudibility =
    slotOrTrack === "source"
      ? { ...current, source: !current.source }
      : isDefaultTrackSlot(slotOrTrack) || slotOrTrack === "target"
        ? { ...current, target: !current.target }
        : {
            ...current,
            bySlot: { ...current.bySlot, [slotOrTrack]: !slotAudible(current, slotOrTrack) },
          }
  persist(fileId, next)
  setQueueAudibility(next)
}
