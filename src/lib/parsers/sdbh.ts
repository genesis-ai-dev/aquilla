// SDBH (Semantic Dictionary of Biblical Hebrew, UBS MARBLE) importer + exporter.
//
// Import: a localized MARBLE JSON file (`SDBH-<lang>.JSON`) is the full lexicon
// (~8k entries / ~17k senses); every sense carries a stable LEXID shared across
// all language editions, and the only per-language content is the LEXSense text
// fields (DefinitionLong/DefinitionShort/Glosses/Comments) plus domain LABEL
// text (domain codes are identical across editions). Cells are one-per-field
// (`sdbh-<LEXID>-<field>`) so edits stay surgical and export is lossless; the
// first field-cell of each sense sets `paragraphStart` so a sense groups as one
// paragraph for multi-cell draft operations.
//
// Export: keyed reinjection into the ORIGINAL XML edition (the JSON is a
// derived projection of the XML). Each `<LEXMeaning Id>` block's LEXSense
// children are regenerated from the current translations; everything outside
// those text nodes is preserved byte-for-byte. Injecting a language's own
// strings into its own XML skeleton must be byte-identical — that invariant is
// what `scripts/sdbh-roundtrip-check.ts` verifies against the real 60MB files.

import type { TranslatableString } from "./types"

// ---------------------------------------------------------------------------
// MARBLE JSON shapes (minimal structural subset — files carry more fields,
// which the parser ignores but the XML skeleton preserves on export).
// ---------------------------------------------------------------------------

export interface SdbhSense {
  LanguageCode: string
  DefinitionLong: string
  DefinitionShort: string
  Glosses: string[] | null
  Comments: string
}

export interface SdbhDomain {
  DomainCode: string | null
  Domain: string | null
}

export interface SdbhMeaning {
  LEXID: string
  LEXDomains: SdbhDomain[] | null
  LEXCoreDomains: SdbhDomain[] | null
  LEXSenses: SdbhSense[] | null
  LEXReferences?: string[] | null
}

export interface SdbhBaseForm {
  BaseFormID: string
  PartsOfSpeech: string[] | null
  LEXMeanings: SdbhMeaning[] | null
}

export interface SdbhEntry {
  MainId: string
  Lemma: string
  AlphaPos: string
  StrongCodes: string[] | null
  BaseForms: SdbhBaseForm[] | null
}

// ---------------------------------------------------------------------------
// Field model — one cell per non-empty translatable field of a sense.
// ---------------------------------------------------------------------------

/** Canonical XML order of the translatable LEXSense children. */
export const SDBH_FIELDS = ["definitionLong", "definitionShort", "glosses", "comments"] as const
export type SdbhField = (typeof SDBH_FIELDS)[number]

const FIELD_LABEL: Record<SdbhField, string> = {
  definitionLong: "Definition (long)",
  definitionShort: "Definition",
  glosses: "Glosses",
  comments: "Comments",
}

/** Gloss lists round-trip through a single cell joined with "; ". Verified
 *  against the real corpus: no gloss in any edition contains a semicolon; the
 *  exporter warns if a translator introduces one (it would split on export). */
export const GLOSS_JOIN = "; "

export function joinGlosses(glosses: string[] | null | undefined): string {
  return (glosses ?? []).join(GLOSS_JOIN)
}

export function splitGlosses(value: string): string[] {
  const trimmed = value.trim()
  if (!trimmed) return []
  return trimmed.split(";").map((g) => g.trim()).filter((g) => g.length > 0)
}

export function sdbhCellId(lexId: string, field: SdbhField): string {
  return `sdbh-${lexId}-${field}`
}

/** Inverse of sdbhCellId. Returns null for non-SDBH cell ids. */
export function parseSdbhCellId(cellId: string): { lexId: string; field: SdbhField } | null {
  const m = /^sdbh-(\d+)-(definitionLong|definitionShort|glosses|comments)$/.exec(cellId)
  if (!m) return null
  return { lexId: m[1], field: m[2] as SdbhField }
}

export const SDBH_DOMAIN_CELL_PREFIX = "sdbh-domain-"
export const SDBH_COREDOMAIN_CELL_PREFIX = "sdbh-coredomain-"

function senseFieldValue(sense: SdbhSense, field: SdbhField): string {
  switch (field) {
    case "definitionLong": return sense.DefinitionLong ?? ""
    case "definitionShort": return sense.DefinitionShort ?? ""
    case "glosses": return joinGlosses(sense.Glosses)
    case "comments": return sense.Comments ?? ""
  }
}

// ---------------------------------------------------------------------------
// Parse — lexicon JSON → per-letter files of TranslatableStrings.
// ---------------------------------------------------------------------------

export interface SdbhParsedFile {
  /** Display name, e.g. "SDBH א". */
  name: string
  strings: TranslatableString[]
}

export interface SdbhParseResult {
  /** One file per Hebrew letter (AlphaPos), in first-seen (alphabetical) order. */
  files: SdbhParsedFile[]
  /** One small extra file: the 390-odd localized domain labels. */
  domainFile: SdbhParsedFile
  senseCount: number
  entryCount: number
}

/** Sense ordinal within its entry, derived from the LEXID structure
 *  (6-digit entry + 3-digit baseform + 3-digit meaning + 3 zeros). */
function senseOrdinal(lexId: string): string {
  const bf = Number(lexId.slice(6, 9))
  const m = Number(lexId.slice(9, 12))
  return `${bf}.${m}`
}

export function parseSdbhLexicon(entries: SdbhEntry[]): SdbhParseResult {
  const byLetter = new Map<string, TranslatableString[]>()
  // Domain labels: first-seen label per code, split by vocabulary (contextual
  // domains vs core domains — the two code spaces overlap numerically).
  const domains = new Map<string, string>()
  const coreDomains = new Map<string, string>()
  let senseCount = 0

  for (const entry of entries) {
    const letter = entry.AlphaPos || "?"
    let strings = byLetter.get(letter)
    if (!strings) {
      strings = []
      byLetter.set(letter, strings)
    }

    for (const bf of entry.BaseForms ?? []) {
      const pos = (bf.PartsOfSpeech ?? []).join(", ")
      for (const meaning of bf.LEXMeanings ?? []) {
        const sense = meaning.LEXSenses?.[0]
        if (!sense) continue
        senseCount += 1

        const domainList = (meaning.LEXDomains ?? []).filter((d) => d.DomainCode)
        const coreList = (meaning.LEXCoreDomains ?? []).filter((d) => d.DomainCode)
        for (const d of domainList) {
          if (d.Domain && !domains.has(d.DomainCode!)) domains.set(d.DomainCode!, d.Domain)
        }
        for (const d of coreList) {
          if (d.Domain && !coreDomains.has(d.DomainCode!)) coreDomains.set(d.DomainCode!, d.Domain)
        }

        const domainLabels = domainList.map((d) => d.Domain).filter(Boolean).join(", ")
        const group = `${entry.Lemma} ${senseOrdinal(meaning.LEXID)}`
        let first = true
        for (const field of SDBH_FIELDS) {
          const value = senseFieldValue(sense, field)
          if (!value) continue
          strings.push({
            id: sdbhCellId(meaning.LEXID, field),
            original: value,
            translated: "",
            context: [entry.Lemma, pos, domainLabels, FIELD_LABEL[field]].filter(Boolean).join(" · "),
            group,
            paragraphStart: first,
            type: "text",
            metadata: {
              sdbh: {
                lexId: meaning.LEXID,
                field,
                lemma: entry.Lemma,
                ...(pos ? { partsOfSpeech: pos } : {}),
                ...(entry.StrongCodes?.length ? { strongCodes: entry.StrongCodes } : {}),
                ...(domainList.length
                  ? { domains: domainList.map((d) => ({ code: d.DomainCode, label: d.Domain })) }
                  : {}),
                ...(coreList.length
                  ? { coreDomains: coreList.map((d) => ({ code: d.DomainCode, label: d.Domain })) }
                  : {}),
              },
            },
          })
          first = false
        }
      }
    }
  }

  const files: SdbhParsedFile[] = [...byLetter.entries()]
    .filter(([, strings]) => strings.length > 0)
    .map(([letter, strings]) => ({ name: `SDBH ${letter}`, strings }))

  const domainStrings: TranslatableString[] = []
  const pushDomain = (prefix: string, kind: string, code: string, label: string) => {
    domainStrings.push({
      id: `${prefix}${code}`,
      original: label,
      translated: "",
      context: `${kind} ${code}`,
      group: code,
      paragraphStart: true,
      type: "text",
      metadata: { sdbh: { domainCode: code, domainKind: kind } },
    })
  }
  for (const [code, label] of [...domains.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    pushDomain(SDBH_DOMAIN_CELL_PREFIX, "domain", code, label)
  }
  for (const [code, label] of [...coreDomains.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    pushDomain(SDBH_COREDOMAIN_CELL_PREFIX, "core-domain", code, label)
  }

  return {
    files,
    domainFile: { name: "SDBH Semantic domains", strings: domainStrings },
    senseCount,
    entryCount: entries.length,
  }
}

// ---------------------------------------------------------------------------
// Localized extraction — a localized edition's JSON → cellId → text map, for
// pre-filling the target column (and for identity round-trip checks).
// ---------------------------------------------------------------------------

export interface SdbhLocalizedStrings {
  /** cellId (sdbh-<LEXID>-<field> and domain-label ids) → localized text.
   *  Empty fields are absent — a blank must never clear a translation. */
  byCellId: Map<string, string>
  languageCode: string | null
}

export function extractSdbhLocalized(entries: SdbhEntry[]): SdbhLocalizedStrings {
  const byCellId = new Map<string, string>()
  let languageCode: string | null = null

  for (const entry of entries) {
    for (const bf of entry.BaseForms ?? []) {
      for (const meaning of bf.LEXMeanings ?? []) {
        const sense = meaning.LEXSenses?.[0]
        if (sense) {
          if (!languageCode && sense.LanguageCode) languageCode = sense.LanguageCode
          for (const field of SDBH_FIELDS) {
            const value = senseFieldValue(sense, field)
            if (value) byCellId.set(sdbhCellId(meaning.LEXID, field), value)
          }
        }
        for (const d of meaning.LEXDomains ?? []) {
          if (d.DomainCode && d.Domain && !byCellId.has(`${SDBH_DOMAIN_CELL_PREFIX}${d.DomainCode}`)) {
            byCellId.set(`${SDBH_DOMAIN_CELL_PREFIX}${d.DomainCode}`, d.Domain)
          }
        }
        for (const d of meaning.LEXCoreDomains ?? []) {
          if (d.DomainCode && d.Domain && !byCellId.has(`${SDBH_COREDOMAIN_CELL_PREFIX}${d.DomainCode}`)) {
            byCellId.set(`${SDBH_COREDOMAIN_CELL_PREFIX}${d.DomainCode}`, d.Domain)
          }
        }
      }
    }
  }

  return { byCellId, languageCode }
}

// ---------------------------------------------------------------------------
// Export — keyed reinjection into the original XML skeleton.
// ---------------------------------------------------------------------------

/** Escape XML text content the way the MARBLE serializer does (.NET
 *  XmlWriter): & < > escaped in text nodes; \r escaped as &#xD;. */
function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r/g, "&#xD;")
}

export interface SdbhInjectOptions {
  /** cellId → translated text (missing ids leave that field empty). */
  byCellId: ReadonlyMap<string, string>
  /** Rewrite LEXSense LanguageCode attributes (needed when bootstrapping a new
   *  language from another edition's skeleton). Omit to preserve the skeleton's. */
  languageCode?: string
  /** Also rewrite localized domain LABEL text (codes never change). Uses the
   *  sdbh-domain-<code> / sdbh-coredomain-<code> ids from byCellId. Off by
   *  default: identity round-trips already carry the right labels. */
  rewriteDomainLabels?: boolean
}

export interface SdbhInjectResult {
  xml: string
  sensesInjected: number
  /** Glosses cells whose text contained ";" inside a gloss — none exist in the
   *  shipped corpus; a translator-introduced one splits on export, so we surface it. */
  warnings: string[]
}

/**
 * Rewrite each `<LEXSense>` block's translatable children from `byCellId`,
 * keyed by the enclosing `<LEXMeaning Id>`. Whitespace, attributes, and every
 * other element are preserved byte-for-byte.
 */
export function injectSdbhXml(skeletonXml: string, opts: SdbhInjectOptions): SdbhInjectResult {
  const warnings: string[] = []
  let sensesInjected = 0

  // Per-LEXMeaning: find its (single) LEXSense element and regenerate children.
  // The corpus is machine-generated and regular: LEXMeaning opening tags carry
  // Id="..." and each contains at most one <LEXSenses> list with one <LEXSense>.
  let out = skeletonXml.replace(
    /(<LEXMeaning Id="(\d+)"[^>]*>)([\s\S]*?)(<\/LEXMeaning>)/g,
    (whole, open: string, lexId: string, body: string, close: string) => {
      const rewritten = body.replace(
        // LEXSense: self-closing never occurs (children always serialized).
        /(<LEXSense\b[^>]*>)([\s\S]*?)(<\/LEXSense>)/,
        (sWhole, sOpen: string, sBody: string, sClose: string) => {
          sensesInjected += 1
          // Indentation: derive from the first child line of the sense body.
          const indentMatch = /\n(\s*)</.exec(sBody)
          const indent = indentMatch ? indentMatch[1] : "                "
          const closeIndent = indent.slice(0, Math.max(0, indent.length - 2))

          const get = (field: SdbhField) => opts.byCellId.get(sdbhCellId(lexId, field)) ?? ""
          const el = (tag: string, value: string) =>
            value ? `${indent}<${tag}>${escapeXmlText(value)}</${tag}>` : `${indent}<${tag} />`

          const glossText = get("glosses")
          const glosses = splitGlosses(glossText)
          if (glosses.some((g) => g.includes(";"))) {
            warnings.push(`sense ${lexId}: semicolon inside a gloss — export splits on ";"`)
          }
          const glossesXml = glosses.length
            ? `${indent}<Glosses>\n${glosses.map((g) => `${indent}  <Gloss>${escapeXmlText(g)}</Gloss>`).join("\n")}\n${indent}</Glosses>`
            : `${indent}<Glosses />`

          let newOpen = sOpen
          if (opts.languageCode) {
            newOpen = newOpen.replace(/LanguageCode="[^"]*"/, `LanguageCode="${opts.languageCode}"`)
          }
          return [
            newOpen,
            el("DefinitionLong", get("definitionLong")),
            el("DefinitionShort", get("definitionShort")),
            glossesXml,
            el("Comments", get("comments")),
            `${closeIndent}${sClose}`,
          ].join("\n")
        },
      )
      return open + rewritten + close
    },
  )

  if (opts.rewriteDomainLabels) {
    out = out.replace(
      /(<(LEXDomain|LEXSubDomain|LEXCoreDomain) Code="([^"]*)"[^>]*>)([^<]*)(<\/\2>)/g,
      (whole, open: string, tag: string, code: string, label: string, close: string) => {
        const prefix = tag === "LEXCoreDomain" ? SDBH_COREDOMAIN_CELL_PREFIX : SDBH_DOMAIN_CELL_PREFIX
        const localized = opts.byCellId.get(`${prefix}${code}`)
        return localized ? `${open}${escapeXmlText(localized)}${close}` : whole
      },
    )
  }

  return { xml: out, sensesInjected, warnings }
}
