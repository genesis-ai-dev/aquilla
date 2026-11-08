// One way to say a recording or film is over the import limit (import map
// D#20). The same 2 GB limit used to be told three ways: the importer's
// "{fileName} exceeds the 2 GB media import limit.", the upload's own
// "This file is 2.1 GB — the limit is 2.0 GB. Split the recording, or
// compress it first." in English only, and the YouTube panel's "Choose a
// non-empty audio or video within the upload limit." with no number. Every
// path now says the importer's sentence, which is translated, and reads the
// limit from MAX_AUDIO_OBJECT_BYTES (AQU-1975) so it can't drift.

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
