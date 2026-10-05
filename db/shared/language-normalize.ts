/**
 * AQU-1597: the one answer to "are these two language labels or codes the
 * same language?". The SPA (`@/lib/language-normalize`), auth-worker and
 * sync-worker import this module so an import warning and a language-code
 * lookup cannot drift.
 *
 * Not a lane identity. Two lanes may share a language; a lane is its id, or
 * the exact `legacy_tag` when a caller only has tags. `sameLanguageTag` is
 * `languagesEqual` — a region is part of the language, not a second one
 * (`fr-CA` and `French` match). A lane that must stay distinct from its base
 * language keeps that check at the lane, beside this comparison.
 *
 * The lookup is the SIL ISO 639-3 catalog (`src/lib/languages/iso-639-3-table`),
 * the same table `codeForLanguageLabel` is heading toward: English name,
 * 639-3 code, and 639-1 `altCode`. Equality is synchronous, so the table is
 * imported here rather than through the picker's dynamic load. 639-2/B
 * bibliographic codes (`fre` for French) are not in that table; the alias
 * map below is only those.
 */

import { ISO_639_3_TABLE } from "../../src/lib/languages/iso-639-3-table"

/** ISO 639-2/B bibliographic code → the 639-3 id the catalog actually lists. */
const ISO6392B_TO_3: Record<string, string> = {
  fre: "fra",
  ger: "deu",
  chi: "zho",
  dut: "nld",
  cze: "ces",
  rum: "ron",
  mac: "mkd",
  alb: "sqi",
  bur: "mya",
  tib: "bod",
  gre: "ell",
  may: "msa",
  ice: "isl",
  arm: "hye",
  baq: "eus",
  geo: "kat",
  wel: "cym",
  slo: "slk",
  per: "fas",
}

interface CatalogEntry {
  code: string
  name: string
  alt: string | null
}

const byKey = new Map<string, string>()
const byCode = new Map<string, CatalogEntry>()

function loadCatalog(): void {
  const names: Array<[string, string]> = []
  for (const line of ISO_639_3_TABLE.split("\n")) {
    if (!line) continue
    const [code, alt, name] = line.split("\t")
    if (!code || !name) continue
    const entry: CatalogEntry = { code, name, alt: alt || null }
    byCode.set(code, entry)
    byKey.set(code.toLowerCase(), code)
    if (alt) byKey.set(alt.toLowerCase(), code)
    names.push([name.toLowerCase(), code])
  }
  for (const [name, code] of names) {
    if (!byKey.has(name)) byKey.set(name, code)
  }
  for (const [alias, code] of Object.entries(ISO6392B_TO_3)) {
    if (byCode.has(code)) byKey.set(alias, code)
  }
}

loadCatalog()

/**
 * Canonical 639-3 id, or the trimmed lowercase input when the catalog has
 * no entry. A region subtag is dropped first (`en-US` → `eng`), which is the
 * same rule `languagesEqual` and `sameLanguageTag` share.
 */
export function normalizeLanguageTag(tag: string | undefined | null): string {
  if (!tag) return ""
  const s = tag.trim().toLowerCase()
  if (!s) return ""
  const head = s.split(/[-_]/)[0]
  return byKey.get(head) ?? head
}

/** True when both values are the same language, or both blank. */
export function languagesEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  return normalizeLanguageTag(a) === normalizeLanguageTag(b)
}

/**
 * Every surface form `languagesEqual` treats as this language: the caller's
 * spelling, the 639-3 id, the English name, the 639-1 code, and a 639-2/B
 * alias when one exists. An empty tag is only itself.
 */
export function languageSurfaceForms(tag: string): string[] {
  const raw = tag.trim()
  if (!raw) return [""]
  const forms = new Set<string>()
  forms.add(raw.toLowerCase())
  const canonical = normalizeLanguageTag(raw)
  if (canonical) forms.add(canonical)
  const entry = byCode.get(canonical)
  if (entry) {
    forms.add(entry.name.toLowerCase())
    if (entry.alt) forms.add(entry.alt.toLowerCase())
  }
  for (const [alias, code] of Object.entries(ISO6392B_TO_3)) {
    if (code === canonical) forms.add(alias)
  }
  return [...forms]
}

/** The canonical language id, with no region. Same key `languagesEqual` compares. */
export function languageTagKey(tag: string | null | undefined): string {
  return normalizeLanguageTag(tag)
}

/** `languagesEqual`. Kept so a caller cannot grow a second region rule. */
export function sameLanguageTag(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return languagesEqual(a, b)
}

/**
 * The candidate that is the same language as `tag`, or `undefined` when none
 * is. An exact spelling wins.
 *
 * This does not name a lane. Two candidates can be the same language and
 * still be two lanes; writing the returned spelling as a lane tag would
 * collapse them.
 */
export function matchLanguageTag(
  tag: string | null | undefined,
  candidates: Iterable<string>,
): string | undefined {
  const raw = (tag ?? "").trim()
  const list = [...candidates]
  const exact = list.find((candidate) => candidate.trim() === raw)
  if (exact !== undefined) return exact
  if (!raw) return undefined
  return list.find((candidate) => candidate.trim().length > 0 && sameLanguageTag(candidate, raw))
}
