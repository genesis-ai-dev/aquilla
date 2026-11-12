import type { InfractionSpan } from "@/lib/parsers/types"

export const MESSAGE = "Corrupted or garbled characters in translation"

/**
 * MQM "Fluency > Character encoding". Three kinds of damage, none of which a
 * translator types on purpose:
 * - U+FFFD, the replacement character a decoder leaves for bytes it couldn't read;
 * - control characters other than tab and line breaks;
 * - UTF-8 read as Windows-1252 ("Ã©" for é, "â€™" for ’, "Â " for a no-break space).
 *
 * The mojibake patterns need the second character too, so plain "Ã" or "Â"
 * in Portuguese, French or Romanian text never matches.
 */
const CORRUPTED_RE =
  // eslint-disable-next-line no-control-regex -- control characters are what this check looks for
  /�|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]|Ã[\u0080-¿]|Â[\u0080-¿]|â€[\u0080-¿ŒœŠšŸŽžƒˆ˜–-›€™]?/g

export function runCheck(source: string, target: string): InfractionSpan[] | null {
  // search() ignores lastIndex, so the shared /g regex carries no state into matchAll.
  if (target.search(CORRUPTED_RE) === -1) return null

  // The same damage in the source came in with the import; the translator
  // can't fix it in the translation, so don't blame the translation for it.
  const inSource = new Set<string>()
  for (const m of source.matchAll(CORRUPTED_RE)) inSource.add(m[0])

  const spans: InfractionSpan[] = []
  for (const m of target.matchAll(CORRUPTED_RE)) {
    if (m.index === undefined || inSource.has(m[0])) continue
    spans.push({ side: "target", start: m.index, end: m.index + m[0].length, matchedText: m[0] })
  }
  return spans.length > 0 ? spans : null
}
