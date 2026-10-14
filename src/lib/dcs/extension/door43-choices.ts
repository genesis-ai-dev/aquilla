// AQU-1937: the Door43 importer's Resource choices, from a catalog listing.
// Official unfoldingWord resources first (Bibles, then translation helps, then
// OBS and grammars), then every other organization's (forks and community
// copies) under their own heading; labelled "ULT — unfoldingWord® Literal Text
// (unfoldingWord)" so a fork never reads like the original.

import type { DcsCatalogEntry } from "../types"

export interface ResourceChoice {
  value: string
  label: string
  group: string
}

export const OFFICIAL_OWNER = "unfoldingWord"
export const OFFICIAL_GROUP = "unfoldingWord"
export const OTHER_GROUP = "Other organizations"

/** Bibles first, then the helps translators reach for, then the rest. */
const SUBJECT_ORDER = [
  /^aligned bible$/i,
  /^bible$/i,
  /translation notes/i,
  /translation questions/i,
  /translation words links/i,
  /translation words/i,
  /translation academy/i,
  /open bible stories/i,
  /obs/i,
  /grammar/i,
]

function subjectRank(subject: string): number {
  const i = SUBJECT_ORDER.findIndex((re) => re.test(subject))
  return i === -1 ? SUBJECT_ORDER.length : i
}

export function resourceLabel(e: DcsCatalogEntry): string {
  const abbr = (e.abbreviation ?? "").toUpperCase()
  const title = e.title?.trim() || e.subject || e.name
  return `${abbr ? `${abbr} — ` : ""}${title} (${e.owner || e.fullName.split("/")[0]})`
}

export function resourceChoices(entries: readonly DcsCatalogEntry[]): ResourceChoice[] {
  const seen = new Set<string>()
  const rows: { e: DcsCatalogEntry; official: boolean }[] = []
  for (const e of entries) {
    if (!e.fullName || seen.has(e.fullName)) continue
    seen.add(e.fullName)
    rows.push({ e, official: e.owner.toLowerCase() === OFFICIAL_OWNER.toLowerCase() })
  }
  rows.sort(
    (a, b) =>
      Number(b.official) - Number(a.official) ||
      subjectRank(a.e.subject) - subjectRank(b.e.subject) ||
      resourceLabel(a.e).localeCompare(resourceLabel(b.e)),
  )
  return rows.map(({ e, official }) => ({ value: e.fullName, label: resourceLabel(e), group: official ? OFFICIAL_GROUP : OTHER_GROUP }))
}
