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

export interface LinkedVideoEmptyStateInput {
  orderedBy: OrderedBy | null | undefined
  /** Rows the file itself projects. Any row at all and the table wins. */
  cellCount: number
  /** The file's linked picture — the YouTube watch page for a linked import. */
  coreMediaUrl: string | null | undefined
  /** Caption tracks attached to this file's timeline, by name. These carry
   *  their OWN content file, so they never show up in `cellCount`: that is
   *  the whole reason the old copy kept insisting the file had no media. */
  captionTrackNames: readonly string[]
}

export interface LinkedVideoEmptyState {
  /** The link is a YouTube video, so the copy may name it as one. */
  isYouTube: boolean
  captionTrackNames: readonly string[]
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
    captionTrackNames: input.captionTrackNames,
  }
}
