// AQU-981 (Sam, Oct 29): several files for one line all upload, as takes, and
// the preview and the upload summary name those lines: "2 takes on Genesis
// 1:1". Shared by the preview (RecordingsUpload) and the banner.

import type { TFunction } from "@/lib/i18n/I18nProvider"
import { formatList, formatNumber } from "@/lib/i18n/format"

export interface LineTakes {
  /** The line, as the preview named it ("Genesis 1:1"). */
  target: string
  count: number
}

/** Lines named before "and 2 more lines". */
export const TAKE_LINES_NAMED = 3

/** "2 takes on Genesis 1:1, 3 takes on Genesis 1:4, and 2 more lines." */
export function takesSentence(t: TFunction, locale: string, lines: readonly LineTakes[]): string {
  const named = lines
    .slice(0, TAKE_LINES_NAMED)
    .map((l) => t("recordingsUpload.takes.onLine", { count: formatNumber(l.count, locale), target: l.target }))
  const more = lines.length - named.length
  if (more > 0) named.push(t("recordingsUpload.takes.moreLines", { count: formatNumber(more, locale) }))
  return t("recordingsUpload.takes.summary", { list: formatList(named, locale, { type: "conjunction" }) })
}
