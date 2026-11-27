// The one size limit for a caption, subtitle or character file, whichever door
// it comes through (import map M-caption-rules, Nov 2). Source cues, Subtitles
// and Characters capped these at 10 MB while Upload files took the same file up
// to 95 MB; they all take the larger now, so nothing that worked is refused.

import { MAX_SOURCE_ARTIFACT_BYTES } from "../../../shared/import-contract"
import { formatByteLimit } from "../i18n/format"

export const MAX_CAPTION_FILE_BYTES = MAX_SOURCE_ARTIFACT_BYTES

/** The limit as a person reads it, e.g. "95.0 MB". */
export function captionFileLimitLabel(locale?: string): string {
  return formatByteLimit(MAX_CAPTION_FILE_BYTES, locale)
}
