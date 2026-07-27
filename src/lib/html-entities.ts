// Dependency-free HTML entity decoder for turning stored rich-text HTML into
// clean plain text. Used when projecting an HTML cell value down to its
// plain-text `value` (migration + read boundary): stripping tags alone leaves
// entities like `&nbsp;` as literal ASCII in the plain string, which then shows
// verbatim in any text (non-HTML) render surface — see AQU-674, where migrated
// Arabic (Algerian) target text displayed literal `&nbsp;` sequences.
//
// Runs in browser, worker and test environments (no DOM dependency), so it is
// deterministic and safe to call from pure mapping code.

// Named entities that realistically appear in migrated Codex rich text. Unknown
// named entities are intentionally left untouched so a legitimate literal
// ampersand (e.g. "Moses & Aaron", or an unrecognised token) is never mangled.
// Space-like entities decode to a regular ASCII space ( ): in a plain-text
// projection we want ordinary word separation, not a stray non-breaking space
// (U+00A0) that would survive trim/search/equality checks unexpectedly.
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  sbquo: "‚",
  bdquo: "„",
  laquo: "«",
  raquo: "»",
  deg: "°",
  plusmn: "±",
  times: "×",
  divide: "÷",
  middot: "·",
  bull: "•",
  dagger: "†",
  Dagger: "‡",
  prime: "′",
  Prime: "″",
  sect: "§",
  para: "¶",
  zwnj: "‌",
  zwj: "‍",
}

// Matches a numeric (decimal or hex) or named character reference.
const ENTITY_RE = /&(#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g

/**
 * Decode HTML character references in `input` to the characters they represent.
 *
 * - Numeric references (`&#160;`, `&#xA0;`) are always decoded.
 * - Named references are decoded from a curated map of entities common in rich
 *   text; unrecognised names are left verbatim (no over-decoding).
 * - A bare `&` that is not part of a valid `&…;` reference is left untouched.
 */
export function decodeHtmlEntities(input: string): string {
  if (!input || input.indexOf("&") === -1) return input

  return input.replace(ENTITY_RE, (match, body: string) => {
    if (body[0] === "#") {
      const codePoint =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10)
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match
      try {
        return String.fromCodePoint(codePoint)
      } catch {
        return match
      }
    }
    const named = NAMED_ENTITIES[body]
    return named !== undefined ? named : match
  })
}
