import type { TranslatableString } from "../parsers/core-types"
import { countSbvUnreadableTimes, extractSbvStrings } from "../parsers/sbv"
import { extractSrtStrings, extractVttStrings,
  repairShortFormCueTimestamps } from "../parsers/subtitle"
import { youTubeVideoId } from "../video/youtube"

export interface YouTubeCaptionInput {
  url: string
  captionName: string
  captionText: string
  rawBytes?: ArrayBuffer
}

export interface PreparedYouTubeCaptionImport {
  name: string
  videoUrl: string
  strings: TranslatableString[]
  /** Cues whose time could not be read, so their wording is not in `strings`.
   *  The preview says how many, with Upload files' own notice. */
  droppedCues: number
  rawSource?: string
  rawSourceFormat: "srt" | "vtt" | "sbv"
  rawBytes?: ArrayBuffer
}

export interface PreparedYouTubePictureImport {
  name: string
  videoUrl: string
  strings: TranslatableString[]
  rawSourceFormat?: undefined
}

/** A linked picture has no downloaded media or invented caption artifact. */
export function prepareYouTubePictureImport(input: {
  url: string
  name: string
}): PreparedYouTubePictureImport {
  const videoId = youTubeVideoId(input.url)
  if (!videoId) throw new Error("Enter a YouTube video link.")
  const name = input.name.trim()
  if (!name) throw new Error("Give the linked video a name.")
  return { name, videoUrl: `https://www.youtube.com/watch?v=${videoId}`, strings: [] }
}

/** Only the user's caption export is a source artifact. No media fetch occurs. */
export function prepareYouTubeCaptionImport(
  input: YouTubeCaptionInput,
): PreparedYouTubeCaptionImport {
  const videoId = youTubeVideoId(input.url)
  if (!videoId) throw new Error("Enter a YouTube video link.")
  const extension = input.captionName.split(".").at(-1)?.toLowerCase()
  if (extension !== "srt" && extension !== "vtt" && extension !== "sbv") {
    throw new Error("Choose your VTT, SRT, or SBV caption export.")
  }
  const normalizedText = input.captionText.replace(/\r\n?/g, "\n")
  const captionBody = extension === "vtt" ? normalizedText
    .split(/\n[ \t]*\n/)
    .filter(block => !/^(?:NOTE|STYLE|REGION)(?:[ \t]|\n|$)/.test(block.trimStart()))
    .join("\n\n") : normalizedText
  const repaired = repairShortFormCueTimestamps(captionBody)
  const strings = extension === "sbv" ? extractSbvStrings(captionBody)
    : extension === "srt" ? extractSrtStrings(captionBody)
      : extractVttStrings(repaired.text)
  if (!strings.length) throw new Error("The caption export contains no timed text.")
  // A cue whose time can't be read is left out and counted, as Upload files
  // does with the same file (import map X-D-silent-cue-drop, M-caption-rules:
  // one rule behind every door). Before, a typo the count missed vanished
  // without a word, and one it caught refused the whole file.
  const droppedCues = extension === "sbv"
    ? countSbvUnreadableTimes(captionBody)
    : Math.max(0, repaired.cueLines - strings.length)
  if (strings.some(cue => !cue.original.trim()
      || !Number.isFinite(cue.start) || !Number.isFinite(cue.end)
      || cue.start! < 0 || Math.round(cue.end! * 1000) <= Math.round(cue.start! * 1000))) {
    throw new Error("Every caption needs text and a positive time range.")
  }
  strings.sort((a, b) => a.start! - b.start!)
  const name = input.captionName.replace(/\.(srt|vtt|sbv)$/i, "").trim()
  if (!name) throw new Error("Give the caption export a file name.")
  return {
    name, videoUrl: `https://www.youtube.com/watch?v=${videoId}`, strings, droppedCues,
    rawSourceFormat: extension,
    ...(input.rawBytes !== undefined
      ? { rawBytes: input.rawBytes } : { rawSource: input.captionText }),
  }
}
