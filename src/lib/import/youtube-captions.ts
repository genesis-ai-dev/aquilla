import type { TranslatableString } from "../parsers/core-types"
import { extractSbvStrings } from "../parsers/sbv"
import { extractSrtStrings, extractVttStrings,
  repairShortFormCueTimestamps } from "../parsers/subtitle"
import { youTubeVideoId } from "../video/youtube"

type CaptionFormat = "srt" | "vtt" | "sbv"

/** A time line whose arrow is mistyped (`->`, `--->`, a dash the keyboard
 *  joined up), with something time-shaped on both sides of it. */
const TYPO_ARROW_TIME =
  /^(?=\S*\d)(?=\S*:)[\w:.,]+\s*(?:-|-{3,}|[–—]-?)>\s*(?=\S*\d)(?=\S*:)[\w:.,]+/
/** Anything shaped like an SBV time line (`H:MM:SS.mmm,H:MM:SS.mmm`), readable or not. */
const LOOSE_SBV_TIME = /^(?=\S*\d)[\w.]*:[\w.]*:[\w.]*,[\w.]*:[\w.]*:[\w.]*$/

/** Is this line a cue's time line, however malformed? */
function looksLikeTimeLine(format: CaptionFormat, line: string): boolean {
  if (format === "sbv") return LOOSE_SBV_TIME.test(line)
  // The parser's own loose test (subtitle.ts), plus a mistyped arrow.
  return repairShortFormCueTimestamps(line).cueLines === 1 || TYPO_ARROW_TIME.test(line)
}

/**
 * The time line as the parser reads it, when it can and the cue runs forwards;
 * null otherwise. Asked of the parser itself (one cue with a stand-in word),
 * so what counts as readable here can never drift from what it accepts.
 */
function readableTimeLine(format: CaptionFormat, line: string): string | null {
  const text = format === "vtt" ? repairShortFormCueTimestamps(line).text : line
  const probe = `${text}\nx`
  const cue = (format === "sbv" ? extractSbvStrings(probe)
    : format === "srt" ? extractSrtStrings(probe) : extractVttStrings(probe))[0]
  if (!cue || !Number.isFinite(cue.start) || !Number.isFinite(cue.end)) return null
  if (cue.start! < 0 || Math.round(cue.end! * 1000) <= Math.round(cue.start! * 1000)) return null
  return text
}

/**
 * AQU-2462 (review, Nov 9): the caption text with every cue that can't be read
 * taken out whole, and how many of them had words.
 *
 * The rule is unchanged (import the readable cues, say how many were left
 * out); this makes the count and the neighbours right:
 *   • a cue is left out when its time can't be read, when its arrow is
 *     mistyped, or when it ends before it starts (that one used to refuse
 *     the whole file);
 *   • it is counted only if it had words: the note says "its wording is not
 *     in this import", and a cue with a time and no words lost nothing;
 *   • its time line and words go with it. With no blank line before it they
 *     used to be glued into the text of the line before.
 */
function keepReadableCues(body: string, format: CaptionFormat): { text: string; dropped: number } {
  const out: string[] = []
  let dropped = 0
  /** Inside a cue being left out: has it had words yet? */
  let leavingOut: { words: boolean } | null = null
  const close = () => {
    if (leavingOut?.words) dropped += 1
    leavingOut = null
  }
  for (const raw of body.split("\n")) {
    const line = raw.trim()
    if (line === "") {
      close()
      out.push("")
    } else if (looksLikeTimeLine(format, line)) {
      close()
      const readable = readableTimeLine(format, line)
      // A cue's number sits just above its time line; it goes with a cue
      // that is left out, or it would read as the last word of the line before.
      if (!readable && format !== "sbv" && /^\d+$/.test(out[out.length - 1]?.trim() ?? "")) out.pop()
      // The blank line ends the cue before, whether or not the file had one.
      out.push("")
      if (readable) out.push(readable)
      else leavingOut = { words: false }
    } else if (leavingOut) {
      leavingOut.words = true
    } else {
      out.push(raw)
    }
  }
  close()
  return { text: out.join("\n"), dropped }
}

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
  // A cue that can't be read is left out and counted, as Upload files does
  // with the same file (import map X-D-silent-cue-drop, M-caption-rules: one
  // rule behind every door). Review, Nov 9: `keepReadableCues` has the detail.
  const kept = keepReadableCues(captionBody, extension)
  const strings = (extension === "sbv" ? extractSbvStrings(kept.text)
    : extension === "srt" ? extractSrtStrings(kept.text)
      : extractVttStrings(kept.text))
    // Nothing but a speaker's name (`<v Ana>`): no words to bring in or lose.
    .filter(cue => cue.original.trim())
  if (!strings.length) throw new Error("The caption export contains no timed text.")
  const droppedCues = kept.dropped
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
