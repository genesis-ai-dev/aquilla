/**
 * InDesign will not line-break a `NoBreak="true"` run. Study IDML uses that
 * for a key term and the punctuation glued to it ("Melchizedek" / ".").
 * Export writes the translation back into those same ranges, so a following
 * sentence can land in the one-character run and keep `NoBreak`. Once that
 * run is wider than the column, composition stops and every later frame
 * stays empty while the text remains in the story.
 *
 * Runs shorter than this still fit a Bible column (the Portuguese hyphenation
 * locks are about 15 characters). Anything longer is released so it can wrap.
 */
const MAX_NO_BREAK_CHARS = 24

function decodeXmlText(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

/**
 * Drop `NoBreak="true"` from character ranges whose own text is too long to
 * sit on one line. Nested ranges are measured on their own, so a footnote
 * inside a short callout does not release the callout.
 */
export function releaseOversizedNoBreak(xml: string): string {
  const token =
    /<CharacterStyleRange\b([^>]*?)(\/?)>|<\/CharacterStyleRange>|<Content>([\s\S]*?)<\/Content>/g
  const stack: Array<{ openStart: number; noBreak: boolean; chars: number }> = []
  const releaseAt: number[] = []
  for (const match of xml.matchAll(token)) {
    const raw = match[0]
    if (raw.startsWith("</")) {
      const frame = stack.pop()
      if (frame?.noBreak && frame.chars > MAX_NO_BREAK_CHARS) releaseAt.push(frame.openStart)
      continue
    }
    if (raw.startsWith("<Content>")) {
      const frame = stack[stack.length - 1]
      if (frame) frame.chars += decodeXmlText(match[3] ?? "").length
      continue
    }
    if (match[2] === "/") continue
    stack.push({
      openStart: match.index ?? 0,
      noBreak: /\sNoBreak="true"/.test(match[1] ?? ""),
      chars: 0,
    })
  }
  if (releaseAt.length === 0) return xml

  let out = xml
  for (const start of releaseAt.sort((left, right) => right - left)) {
    const openEnd = out.indexOf(">", start)
    if (openEnd < 0) continue
    const open = out.slice(start, openEnd)
    out = out.slice(0, start) + open.replace(/\sNoBreak="true"/, "") + out.slice(openEnd)
  }
  return out
}
