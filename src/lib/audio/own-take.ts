// AQU-2411: what counts as a line's OWN take — one answer for every surface.
//
// The id convention (db/shared/audio-id.ts) tags a take with the id of the
// line it was recorded for, and an imported source recording with the FILE's
// id. That tag was the whole test: a chosen recording whose id did not carry
// the line's id was assumed to be the imported source recording.
//
// Takes that came over from Codex break that assumption. The migration keeps
// Codex's file name as the take's id (src/lib/migrate/audio.ts), and Codex
// named takes `audio-<time>-<random>` until Oct 2025, then tagged them with
// the verse written its own way (`gen-1:1`), and only since Dec 2025 with the
// line's id. So an older migrated take carries no id the app recognises: the
// Recording tab listed it (it only leaves out the file-tagged recording) while
// the timeline, playback and the audio counts read the line as unrecorded —
// ETEN's Xiang Genesis, Nov 5.
//
// The rule, in both forms below:
// - a recording tagged with the line's id is the line's own take, as before;
// - an untagged one marked `role: "source"`, or tagged with the file's id,
//   never is;
// - on a section of an imported recording (`medium: "media"`) nothing else is
//   either, because there an untagged recording can still be the shared
//   source recording an older import attached;
// - on any other line an untagged recording IS the line's own take: a verse
//   or a subtitle cue never holds a source recording that is not marked one of
//   those two ways.

import { audioIdSeededWith } from "../../../db/shared/audio-id"
import { slotSelections, type CellAudioEntry } from "@/lib/sync/cell-audio-read-types"
import type { SegmentMedium } from "@/lib/sync/cells-read-types"

/** Just enough of a line to place a recording on it. */
export interface TakeLine {
  id: string
  fileId?: string | null
  /** Unset is a text line, as it is everywhere else. */
  medium?: SegmentMedium | null
}

type RoleOf = { role?: "dub" | "source" | null } | null | undefined

/** Is `audioId` this line's own take, rather than a source recording it shows? */
export function isOwnTake(line: TakeLine, audioId: string | null | undefined, att?: RoleOf): boolean {
  if (!audioId) return false
  if (audioIdSeededWith(audioId, line.id)) return true
  if (att?.role === "source" || line.medium === "media") return false
  return !(line.fileId && audioIdSeededWith(audioId, line.fileId))
}

type Selections = Pick<CellAudioEntry, "selectedBySlot" | "selectedAudioId" | "selectedGeneratedVoiceAudioId">

/**
 * The recordings chosen on more than one line of a file: the shared imported
 * source recording, which sits chosen on every section it covers.
 *
 * For the counters that only hold the file's audio by line, not the lines
 * themselves, this stands in for `medium`: a take belongs to one line, so a
 * recording chosen on two cannot be anybody's take.
 */
export function sharedSelections(entries: Iterable<Selections>): Set<string> {
  const seen = new Set<string>()
  const shared = new Set<string>()
  for (const entry of entries) {
    const ids = new Set(Object.values(slotSelections(entry)))
    for (const id of ids) {
      if (seen.has(id)) shared.add(id)
      else seen.add(id)
    }
  }
  return shared
}

/**
 * `isOwnTake` for a chosen recording when only the file's audio map is known.
 *
 * `shared` is `sharedSelections` over the whole file. Without it the line's
 * neighbours can't be seen, so only a recording tagged with the line's id
 * counts — the rule before AQU-2411. Give the line's `fileId` whenever it is
 * known, so a file-tagged recording never counts even on a file of one line.
 */
export function isOwnSelection(
  line: string | Pick<TakeLine, "id" | "fileId">,
  audioId: string | null | undefined,
  att: RoleOf,
  shared: ReadonlySet<string> | null,
): boolean {
  const { id, fileId } = typeof line === "string" ? { id: line, fileId: null } : line
  if (!audioId) return false
  if (audioIdSeededWith(audioId, id)) return true
  if (!shared || !att || att.role === "source") return false
  if (fileId && audioIdSeededWith(audioId, fileId)) return false
  return !shared.has(audioId)
}
