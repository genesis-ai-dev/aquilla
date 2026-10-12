// Does this FILE have audio? (AQU-1495)
//
// Two places ask, and they must never disagree: the selection bar, which shows
// its "Validate audio" pair only on a file with recordings, and the editor's
// gutter, which draws its audio column on the same condition (Sam, 2026-10-01,
// amending the "a mic on every row" ruling of 09-23 — removing a project's last
// recording left a faded mic on every line, and a text-only project wore one
// on every line it ever had).
//
// "Audio" is a recording somebody could validate: a selected dub take on one of
// the file's lines, or — in a dubbing file, whose recordings live on the heard
// lines performing its subtitles — on one of those.

import { selectedDubTakes, type CellAudioEntry } from "@/lib/sync/cell-audio-read-types"
import type { LinkedTake } from "@/lib/audio/linked-takes"

export function fileHasAudio(
  byCellId: ReadonlyMap<string, CellAudioEntry> | null | undefined,
  linkedTakesByCell: ReadonlyMap<string, readonly LinkedTake[]> | null | undefined,
): boolean {
  // A dubbing file's recordings are on its heard lines, not its rows.
  for (const heard of linkedTakesByCell?.values() ?? []) {
    if (heard.some((h) => h.hasTake)) return true
  }
  for (const entry of byCellId?.values() ?? []) {
    if (selectedDubTakes(entry).length > 0) return true
  }
  return false
}

/**
 * What the gutter's audio column shows: nothing, a loading placeholder on every
 * line, or the lines' controls (a faded mic where a line has no recording).
 */
export type AudioColumn = "off" | "checking" | "on"

/**
 * While the file's recordings are still being read, an empty answer means
 * "not known yet". A placeholder there is right on a file that turns out to
 * have audio (the 3G pass, 2026-10-01: every line said "No audio to validate"
 * for seconds) and wrong on one that does not — a pulse on every line of a
 * text-only file, then a column that vanishes. So the placeholder is drawn
 * only where audio is expected, and otherwise the column waits to be known.
 */
export function audioColumnFor(args: {
  /** Audio already seen, in whatever has been read so far. */
  hasAudio: boolean
  /** Some of the file's recordings have not been read yet. */
  checking: boolean
  /** No answer yet, but this file is expected to have audio. */
  expectAudio: boolean
}): AudioColumn {
  const { hasAudio, checking, expectAudio } = args
  if (!checking) return hasAudio ? "on" : "off"
  // A line never shows a count that is about to change: known audio waits for
  // the rest of the reads behind the same placeholder.
  return hasAudio || expectAudio ? "checking" : "off"
}

// Which files were last seen with audio, this session. Memory only: a file is
// "expected" to have audio because it had some the last time it was read, so
// coming back to it shows the placeholder rather than a column that pops in.
// Keyed `${projectId}/${fileId}`.
const lastSeenWithAudio = new Map<string, boolean>()

export function rememberFileAudio(key: string, hasAudio: boolean): void {
  lastSeenWithAudio.set(key, hasAudio)
}

export function fileLastSeenWithAudio(key: string): boolean {
  return lastSeenWithAudio.get(key) === true
}

export function __resetFileAudioMemoryForTests(): void {
  lastSeenWithAudio.clear()
}
