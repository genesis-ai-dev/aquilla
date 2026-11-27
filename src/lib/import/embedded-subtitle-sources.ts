import { extractEmbeddedSubtitles } from "../parsers/embedded-subtitles"
import type { TranslatableString } from "../parsers/core-types"
import { MAX_SOURCE_ARTIFACT_BYTES } from "../../../shared/import-contract"

/** The files whose embedded captions are looked for: .mp4 and .m4a. */
export function mayCarryEmbeddedCaptions(name: string): boolean {
  return /\.(mp4|m4a)$/i.test(name)
}

/**
 * AQU-2344 (review, Nov 9): one rule behind every door that looks for captions
 * inside a film. Finding them reads the whole file into memory, so only a
 * file within the source ceiling is read; a larger one (a whole episode) is
 * imported without being checked, and the import says so. Upload files had
 * this guard and said nothing; the YouTube panel had no guard and tried to
 * hold a 1.8 GB film in memory.
 */
export function embeddedCaptionsUnread(file: { name: string; size: number }): boolean {
  return mayCarryEmbeddedCaptions(file.name) && file.size > MAX_SOURCE_ARTIFACT_BYTES
}

export interface EmbeddedSubtitleSource {
  id: string
  label: string
  language: string | null
  source: { cues: TranslatableString[] }
}

/** Preserve exact cue clocks for review. In particular, short heading cues
 * need correction before millisecond timeline persistence, never silent loss.
 * The containing media remains the original source artifact.
 */
export function prepareEmbeddedSubtitleSources(
  buffer: ArrayBuffer,
): EmbeddedSubtitleSource[] {
  return extractEmbeddedSubtitles(buffer).map((track, trackIndex) => {
    const id = `embedded-track-${trackIndex + 1}`
    const label = `Embedded captions ${trackIndex + 1}${
      track.language ? ` (${track.language})` : ""
    }`
    return {
      id,
      label,
      language: track.language,
      source: {
        cues: track.cues.map((cue, cueIndex) => ({
          id: `${id}-cue-${cueIndex + 1}`,
          type: "cue",
          original: cue.text,
          translated: "",
          context: label,
          group: id,
          start: cue.start,
          end: cue.end,
        })),
      },
    }
  })
}
