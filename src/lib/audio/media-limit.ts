// One way to say a recording or film is over the import limit (import map
// D#20). The same 2 GB limit used to be told three ways: the importer's
// "{fileName} exceeds the 2 GB media import limit.", the upload's own
// "This file is 2.1 GB — the limit is 2.0 GB. Split the recording, or
// compress it first." in English only, and the YouTube panel's "Choose a
// non-empty audio or video within the upload limit." with no number. Every
// way in (the importer, the YouTube panel, a file dropped on an empty file)
// now refuses such a file first with the importer's sentence, translated,
// reading the limit from MAX_AUDIO_OBJECT_BYTES (AQU-1975) so it can't drift.
// The upload's own backstop says the same sentence in English.
//
// Work Review question 122 (Nov 27): a recording over the limit was still
// offered "Import whole recording" and "Import and transcribe…" and failed
// only after that. Every way a recording is picked (Upload files' picker and
// drop, a file's Upload recordings, a file's card) now asks
// `mediaOverLimitMessage` first, before anything is measured or uploaded.

import { formatByteLimit } from "@/lib/i18n/format"
import { normalizeLocale } from "@/lib/i18n/locales"
import { t } from "@/lib/i18n/standalone"
import { readStoredLocale } from "@/lib/i18n/store"
import { MAX_AUDIO_OBJECT_BYTES } from "./upload"

export function mediaFileTooLargeMessage(fileName: string): string {
  const locale = normalizeLocale(readStoredLocale())
  return t("importExport.errors.mediaFileTooLarge", {
    fileName, limit: formatByteLimit(MAX_AUDIO_OBJECT_BYTES, locale),
  })
}

/** The sentence for the first file over the limit, or null when all fit. */
export function mediaOverLimitMessage(files: readonly { name: string; size: number }[]): string | null {
  const over = files.find((file) => file.size > MAX_AUDIO_OBJECT_BYTES)
  return over ? mediaFileTooLargeMessage(over.name) : null
}
