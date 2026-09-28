// The colour a take is drawn in off the timeline. (Sam, 2026-09-26)
//
// The Audio view, the Recording tab and the recorder draw a take as its
// timeline chip, and now in its TRACK'S colour rather than grey: the file's
// dub track for its main recording and generated voice, an added track's own
// colour for a take made on that track, and the source-audio blue for a
// section of an imported source recording. The colour is the one stored with
// the FILE (files.meta.trackOverrides, set by `file.track.set`), so it is the
// same for everyone on the project and the same one the timeline draws.
//
// Read through `deriveTracksForFile`, the one reader tracks.ts allows, so an
// override this build does not understand is ignored exactly as the timeline
// ignores it.

import { deriveTracksForFile, type PersistedTrackOverrides } from "./tracks"
import { trackHueVarsFor } from "./track-colors"
import { DEFAULT_TARGET_TRACK_ID, trackIdForSlot } from "./track-slots"

/** The part of a file record a colour is read from. */
export interface TrackColorSource {
  id: string
  trackOverrides?: PersistedTrackOverrides | null
}

function findFile(files: readonly TrackColorSource[] | null | undefined, fileId: string | null | undefined) {
  return fileId ? files?.find((f) => f.id === fileId) ?? null : null
}

/** One track's stored colour token in a file; null means the default hue. */
export function fileTrackColor(
  files: readonly TrackColorSource[] | null | undefined,
  fileId: string | null | undefined,
  trackId: string,
): string | null {
  const file = findFile(files, fileId)
  const track = deriveTracksForFile(file).find((tr) => tr.id === trackId)
  return track?.color ?? null
}

/**
 * The custom properties a take's rectangle is drawn with.
 *
 * `slot` is the attachment's own slot ("recording", "generatedVoice" or an
 * added track's); absent means the file's dub track. A source-audio section is
 * not a take on any dub track, so it wears the source row's fixed colour.
 */
interface TakeColorInput {
  files: readonly TrackColorSource[] | null | undefined
  fileId: string | null | undefined
  slot?: string | null
  sourceSection?: boolean
}

function takeTrack(input: TakeColorInput) {
  const trackId = input.slot ? trackIdForSlot(input.slot) : DEFAULT_TARGET_TRACK_ID
  return deriveTracksForFile(findFile(input.files, input.fileId)).find((tr) => tr.id === trackId)
}

export function takeTrackVars(input: TakeColorInput): Record<string, string> {
  if (input.sourceSection) return trackHueVarsFor("source-audio", null)
  const track = takeTrack(input)
  // A take whose track is gone (deleted, or from a build this one cannot
  // draw) still shows as a take — in the dub track's colour, never grey.
  return trackHueVarsFor(track?.kind ?? "target-audio", track?.color ?? null)
}

/** The colour token a take is drawn in ("amber", …); null is the default
 *  hue, and a source-audio section's fixed colour. */
export function takeTrackColor(input: TakeColorInput): string | null {
  if (input.sourceSection) return null
  return takeTrack(input)?.color ?? null
}
