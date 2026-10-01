import type { TranslatableString } from "../parsers/core-types"
import { extractSbvStrings } from "../parsers/sbv"
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
  rawSource?: string
  rawSourceFormat: "srt" | "vtt" | "sbv"
  rawBytes?: ArrayBuffer
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
  const expectedCues = extension === "sbv"
    ? captionBody.split(/\n\s*\n/).filter(block => block.trim()).length
    : repaired.cueLines
  if (strings.length !== expectedCues) {
    throw new Error("Some caption cues could not be read. Correct their timings and import again.")
  }
  if (strings.some(cue => !cue.original.trim()
      || !Number.isFinite(cue.start) || !Number.isFinite(cue.end)
      || cue.start! < 0 || Math.round(cue.end! * 1000) <= Math.round(cue.start! * 1000))) {
    throw new Error("Every caption needs text and a positive time range.")
  }
  strings.sort((a, b) => a.start! - b.start!)
  const name = input.captionName.replace(/\.(srt|vtt|sbv)$/i, "").trim()
  if (!name) throw new Error("Give the caption export a file name.")
  return {
    name, videoUrl: `https://www.youtube.com/watch?v=${videoId}`, strings,
    rawSourceFormat: extension,
    ...(input.rawBytes !== undefined
      ? { rawBytes: input.rawBytes } : { rawSource: input.captionText }),
  }
}
