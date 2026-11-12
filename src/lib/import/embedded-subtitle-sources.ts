import { extractEmbeddedSubtitles } from "../parsers/embedded-subtitles"
import type { TranslatableString } from "../parsers/core-types"

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
