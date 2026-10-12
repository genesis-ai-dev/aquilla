// AQU-1565: what the editor's empty table should say on a time-ordered file
// that has NO rows of its own but DOES have a linked video.
//
// A "Link video only" YouTube import (AQU-1556) produces exactly that file:
// `orderedBy: "time"`, zero cells, and a `coreMediaUrl` pointing at the watch
// page. The generic empty table claimed "No media on this file yet" and
// offered a direct-media-URL field that rejects the very link the user had
// just imported — three statements, all false for this file. What the file
// actually wants is captions, and captions arrive on the Media view's
// timeline, which that prompt never mentioned.
//
// Kept pure (no hook, no React) so the decision is testable on its own, the
// same shape as cell-area-state.ts next door.

import type { OrderedBy } from "@/lib/parsers/types"
import { youTubeVideoId } from "@/lib/video/youtube"
import { ROLE } from "@/lib/frontier/roles"
import { canAttachSourceAudio } from "@/lib/sync/role-policy"

export interface LinkedVideoEmptyStateInput {
  orderedBy: OrderedBy | null | undefined
  /** Rows the file itself projects. Any row at all and the table wins. */
  cellCount: number
  /** The file's linked picture — the YouTube watch page for a linked import. */
  coreMediaUrl: string | null | undefined
  /** Caption tracks attached to this file's timeline. These carry their OWN
   *  content file, so they never show up in `cellCount`: that is the whole
   *  reason the old copy kept insisting the file had no media. */
  captionTracks: readonly LinkedVideoCaptionTrack[]
}

/** AQU-1566: one attached caption track, as the empty state names (and may
 *  offer to turn into this file's rows) it. */
export interface LinkedVideoCaptionTrack {
  id: string
  name: string
  /** A source caption track with its own content: the only kind the server
   *  will copy into the file's rows. A target-text track is named but never
   *  offered. */
  canBecomeRows: boolean
}

export interface LinkedVideoEmptyState {
  /** The link is a YouTube video, so the copy may name it as one. */
  isYouTube: boolean
  captionTracks: readonly LinkedVideoCaptionTrack[]
}

/**
 * The linked-video empty state, or `null` when the ordinary attach-media
 * prompt is still the right thing to show (no linked video) or no empty state
 * is wanted at all (the file has rows).
 */
export function deriveLinkedVideoEmptyState(
  input: LinkedVideoEmptyStateInput,
): LinkedVideoEmptyState | null {
  if (input.orderedBy !== "time") return null
  if (input.cellCount > 0) return null
  const url = input.coreMediaUrl?.trim()
  if (!url) return null
  return {
    isYouTube: youTubeVideoId(url) !== null,
    captionTracks: input.captionTracks,
  }
}

/**
 * AQU-1566 (Sam's option b): does a caption file attached to this file become
 * its OWN rows, rather than a timeline-only track? Yes for exactly the file the
 * empty state above is for: a linked video with no rows. Later captions, on a
 * file that has rows, stay timeline tracks.
 *
 * "No rows" is believed only once the rows have loaded, and loaded cleanly. An
 * empty list while they load (or after a failed read) is not an answer, and
 * guessing "rows" there would route a second caption file into a promotion the
 * server refuses. The server refuses a file with rows anyway; this keeps the
 * dialog from offering the wrong thing in the first place.
 */
export function captionsBecomeRows(
  emptyState: LinkedVideoEmptyState | null,
  rows: { loading: boolean; failed: boolean },
): boolean {
  return emptyState !== null && !rows.loading && !rows.failed
}

/** Who is offered what on an empty time-ordered file, and in the caption dialog. */
export interface MediaEmptyGates {
  /** Attach captions in place, and "Use (track) as this file's rows". */
  offerCaptionRows: boolean
  /** The timeline's Sources > Attach captions is enabled. */
  canImportCaptions: boolean
  /** Upload (or link) the file's original recording. */
  canUploadSourceMedia: boolean
}

/**
 * The role gates for those offers, in one place so a test can pin them. Each
 * mirrors the server's floor for the write it leads to; offering below that
 * floor leaves a person with a button that fails, or worse, half an import:
 *
 *  - captions as rows: maintainer (the promotion's floor), with NO
 *    track-editing switch (Sam's ruling). The /import staging step only needs
 *    Project Lead, so a Project Lead offered this would stage a hidden file and
 *    then be refused at the promotion;
 *  - captions as a timeline track: maintainer AND track editing on, as before;
 *  - the original recording: Project Lead and up, because it is stored as the
 *    file's source audio (`canAttachSourceAudio`, the server's floor). Below
 *    that nobody can add it, so nobody is offered it.
 *
 * `roleLevel` null is "not known yet": the source-audio check fails open like
 * every `role-policy` check, the maintainer checks fail closed as the
 * workspace always has.
 */
export function mediaEmptyGates(input: {
  roleLevel: number | null | undefined
  captionRowsMode: boolean
  /** Maintainer and the project's track-editing switch on. */
  canEditTracks: boolean
}): MediaEmptyGates {
  const maintainer = (input.roleLevel ?? 0) >= ROLE.MAINTAINER
  return {
    offerCaptionRows: input.captionRowsMode && maintainer,
    canImportCaptions: input.captionRowsMode ? maintainer : input.canEditTracks,
    canUploadSourceMedia: canAttachSourceAudio(input.roleLevel ?? null),
  }
}
