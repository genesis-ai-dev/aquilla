// Binding a chip to the clip-preview engine. (AQU-646 stage 5)
//
// The same division of labour `useTargetChipPeaks` next door already uses, and
// for the same reason: everything the engine needs to reach an audio file —
// the project, the session that mints its token, and the file that OWNS the
// clip, which on a linked take is a hidden cue sibling and not the file on
// screen — lives in the LANE, while the thing that wants to make a sound is the
// CHIP, twenty props deep.
//
// So the lane binds and the chip receives one object. That keeps the chip's
// prop list from growing three more entries, and it keeps the "absent means the
// feature simply is not there" discipline that `peaks` already has: a lane
// rendered without a project or a session hands out nothing, which is exactly
// what this lane's own test suite does today and why it needs no new setup.

import { useCallback } from "react"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import {
  openGrainScrub,
  playClip,
  primeClipPreview,
  type ClipPreviewHandle,
  type ClipPreviewSource,
  type GrainScrub,
} from "@/lib/audio/clip-preview"
import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"

/** What one chip can do with its own audio. */
export interface ChipPreview {
  /** Resume the device and start the decode, synchronously inside a gesture —
   *  browsers only honour a resume while the gesture is still open. */
  prime(): void
  /** Play the clip as the timeline draws it. Sounds through a muted track:
   *  Sam's ruling is that this button is an inspection tool. */
  play(window: { startSec: number; endSec: number | null }, opts?: { onEnded?(): void }): ClipPreviewHandle
  /** Tape noises under a trim handle. Respects the track's mute — the other
   *  half of the same ruling. */
  scrub(edge: "in" | "out"): GrainScrub
}

export interface UseChipPreviewArgs {
  projectId: string | null
  session: FrontierSession | null
  /** Read LIVE, per grain — the speaker button can be flipped mid-drag. */
  isMuted: () => boolean
}

export type ChipPreviewFactory = (
  cell: CellData,
  audioId: string,
  durationSec: number | null,
) => ChipPreview | undefined

export function useChipPreview({ projectId, session, isMuted }: UseChipPreviewArgs): ChipPreviewFactory {
  return useCallback(
    (cell, audioId, durationSec) => {
      const url = cell.attachments?.[audioId]?.url
      if (!projectId || !session || !url) return undefined
      const src: ClipPreviewSource = {
        url,
        projectId,
        // The clip's OWN file, not the lane's — see the header.
        fileId: cell.fileId,
        getSyncToken: audioSyncTokenFetcherForSession(session),
        durationSec,
      }
      return {
        prime: () => { void primeClipPreview(src) },
        play: (window, opts) => playClip(src, window, { onEnded: opts?.onEnded }),
        scrub: (edge) => openGrainScrub(src, { edge, isMuted }),
      }
    },
    [projectId, session, isMuted],
  )
}
