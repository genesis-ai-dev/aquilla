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
// AQU-793: each LEXMeaning also carries CONTEXTUAL meanings (collocations,
// idioms, syntactic frames) with their own CONSense text. They are a distinct
// category from the lexical sense — the English master has ~21.6k of them,
// most localized editions almost none — so they land as their own cells
// (`sdbh-con-<CONID>-<field>`), tagged "Contextual meaning", directly after
// the sense they belong to. Every cell carries `metadata.tags` (headword, layer,
// field) and an explicit per-headword milestone so the editor's sticky section
// header names the lemma the reader is inside.
//
// Export: keyed reinjection into the ORIGINAL XML edition (the JSON is a
// derived projection of the XML). Each `<LEXMeaning Id>` block's LEXSense
// children — and each `<ContextualMeaning Id>` block's CONSense children — are
// regenerated from the current translations; everything outside those text
// nodes is preserved byte-for-byte. Injecting a language's own strings into its
// own XML skeleton must be byte-identical — that invariant is what
// `scripts/sdbh-roundtrip-check.ts` verifies against the real 60MB files.

import type { ImportMilestone } from "../../../shared/import-contract"
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

export interface SdbhContextualMeaning {
  CONID: string
  CONType?: string | null
  CONDomains: SdbhDomain[] | null
  CONForms: string[] | null
  CONCollocations: string[] | null
  CONSenses: SdbhSense[] | null
  CONReferences?: string[] | null
}

export interface SdbhMeaning {
  LEXID: string
  LEXDomains: SdbhDomain[] | null
  LEXCoreDomains: SdbhDomain[] | null
  LEXSenses: SdbhSense[] | null
  LEXReferences?: string[] | null
  CONMeanings?: SdbhContextualMeaning[] | null
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

/** Canonical XML order of the translatable LEXSense/CONSense children. */
export const SDBH_FIELDS = ["definitionLong", "definitionShort", "glosses", "comments"] as const
export type SdbhField = (typeof SDBH_FIELDS)[number]

const FIELD_LABEL: Record<SdbhField, string> = {
  definitionLong: "Definition (long)",
  definitionShort: "Definition",
  glosses: "Glosses",
  comments: "Comments",
}

/** Per-cell content-type tag (AQU-793 feedback 1): a reader must see at a
 *  glance whether a cell is a gloss, a definition, or a comment. Persisted
 *  wire-format content, deliberately English like import milestone labels. */
export const SDBH_FIELD_TAG: Record<SdbhField, string> = {
  definitionLong: "Definition (long)",
  definitionShort: "Definition",
  glosses: "Gloss",
  comments: "Comment",
}
export const SDBH_CONTEXTUAL_TAG = "Contextual meaning"

// Verse-reference lists longer than this are NOT imported into cell metadata.
// High-frequency lemmas list thousands; unbounded, one cell's metadata exceeded
// the sync-worker's 64 KB cell.metadata limit and the whole import 400'd.
// Rather than silently truncate, the cell carries `referencesNotImported: true`
// + `referenceCount`, and the parse result lists every affected meaning so the
// import flow can ask before proceeding. Export is unaffected: `injectSdbhXml`
// rewrites sense text into the preserved edition skeleton and never touches
// <CONReferences>.
export const SDBH_MAX_REFERENCES = 1000

export interface SdbhNotImportedField {
  conId: string
  lemma: string
  field: "references"
  /** Length of the omitted list. */
  count: number
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

export type SdbhLayer = "sense" | "contextual"

export function sdbhCellId(lexId: string, field: SdbhField): string {
  return `sdbh-${lexId}-${field}`
}

export const SDBH_CON_CELL_PREFIX = "sdbh-con-"

export function sdbhConCellId(conId: string, field: SdbhField): string {
  return `${SDBH_CON_CELL_PREFIX}${conId}-${field}`
}

/** Inverse of sdbhCellId / sdbhConCellId. Returns null for non-SDBH cell ids.
 *  `meaningId` is the LEXID for a sense cell, the CONID for a contextual one. */
export function parseSdbhCellId(
  cellId: string,
): { layer: SdbhLayer; meaningId: string; field: SdbhField } | null {
  const m = /^sdbh-(con-)?(\d+)-(definitionLong|definitionShort|glosses|comments)$/.exec(cellId)
  if (!m) return null
  return { layer: m[1] ? "contextual" : "sense", meaningId: m[2], field: m[3] as SdbhField }
}

export const SDBH_DOMAIN_CELL_PREFIX = "sdbh-domain-"
export const SDBH_COREDOMAIN_CELL_PREFIX = "sdbh-coredomain-"
export const SDBH_CONDOMAIN_CELL_PREFIX = "sdbh-condomain-"

function senseFieldValue(sense: SdbhSense, field: SdbhField): string {
  switch (field) {
    case "definitionLong": return sense.DefinitionLong ?? ""
    case "definitionShort": return sense.DefinitionShort ?? ""
    case "glosses": return joinGlosses(sense.Glosses)
    case "comments": return sense.Comments ?? ""
  }
}

function domainRefs(list: SdbhDomain[] | null | undefined): { code: string; label: string | null }[] {
  return (list ?? [])
    .filter((d): d is SdbhDomain & { DomainCode: string } => Boolean(d.DomainCode))
    .map((d) => ({ code: d.DomainCode, label: d.Domain }))
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
  /** One small extra file: the localized domain labels (lexical, core, contextual). */
  domainFile: SdbhParsedFile
  senseCount: number
  /** Contextual meanings that produced at least one cell. */
  contextualMeaningCount: number
  entryCount: number
  /** Fields dropped from cell metadata because they exceed the size budget. */
  notImported: SdbhNotImportedField[]
}

/** Sense ordinal within its entry, derived from the LEXID structure
 *  (6-digit entry + 3-digit baseform + 3-digit meaning + 3-digit contextual). */
function senseOrdinal(lexId: string): string {
  const bf = Number(lexId.slice(6, 9))
  const m = Number(lexId.slice(9, 12))
  return `${bf}.${m}`
}

function contextualOrdinal(conId: string): string {
  return `${senseOrdinal(conId)}.${Number(conId.slice(12, 15))}`
}

/** One milestone per headword (AQU-793 feedback 4): the editor's sticky
 *  section header and milestone picker then name the lemma, not "Part 3". */
function lemmaMilestone(entry: SdbhEntry): ImportMilestone {
  return {
    key: `lemma:${entry.MainId}`,
    kind: "section",
    label: entry.Lemma,
    shortLabel: entry.Lemma,
  }
}

export function parseSdbhLexicon(entries: SdbhEntry[]): SdbhParseResult {
  const byLetter = new Map<string, TranslatableString[]>()
  // Domain labels: first-seen label per code, split by vocabulary (contextual
  // domains vs core domains — the two code spaces overlap numerically).
  const domains = new Map<string, string>()
  const coreDomains = new Map<string, string>()
  const contextualDomains = new Map<string, string>()
  let senseCount = 0
  let contextualMeaningCount = 0
  const notImported: SdbhNotImportedField[] = []

  const rememberLabels = (into: Map<string, string>, list: SdbhDomain[] | null | undefined) => {
    for (const d of list ?? []) {
      if (d.DomainCode && d.Domain && !into.has(d.DomainCode)) into.set(d.DomainCode, d.Domain)
    }
  }

  for (const entry of entries) {
    const letter = entry.AlphaPos || "?"
    let strings = byLetter.get(letter)
    if (!strings) {
      strings = []
      byLetter.set(letter, strings)
    }
    const milestone = lemmaMilestone(entry)

    for (const bf of entry.BaseForms ?? []) {
      const pos = (bf.PartsOfSpeech ?? []).join(", ")
      for (const meaning of bf.LEXMeanings ?? []) {
        const sense = meaning.LEXSenses?.[0]
        if (!sense) continue
        senseCount += 1

        const domainList = domainRefs(meaning.LEXDomains)
        const coreList = domainRefs(meaning.LEXCoreDomains)
        rememberLabels(domains, meaning.LEXDomains)
        rememberLabels(coreDomains, meaning.LEXCoreDomains)

        const domainLabels = domainList.map((d) => d.label).filter(Boolean).join(", ")
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
            milestone,
            paragraphStart: first,
            type: "text",
            metadata: {
              tags: [entry.Lemma, SDBH_FIELD_TAG[field]],
              sdbh: {
                layer: "sense",
                lexId: meaning.LEXID,
                field,
                lemma: entry.Lemma,
                ...(pos ? { partsOfSpeech: pos } : {}),
                ...(entry.StrongCodes?.length ? { strongCodes: entry.StrongCodes } : {}),
                ...(domainList.length ? { domains: domainList } : {}),
                ...(coreList.length ? { coreDomains: coreList } : {}),
              },
            },
          })
          first = false
        }

        // Contextual meanings ride directly after their sense so the reader
        // sees "sense, then its idioms/collocations" — and is never left to
        // guess which of the two a cell is: the tag says so.
        for (const con of meaning.CONMeanings ?? []) {
          const conSense = con.CONSenses?.[0]
          if (!conSense) continue
          const conDomains = domainRefs(con.CONDomains)
          rememberLabels(contextualDomains, con.CONDomains)
          const collocations = (con.CONCollocations ?? []).filter(Boolean)
          const forms = (con.CONForms ?? []).filter(Boolean)
          const conGroup = `${entry.Lemma} ${contextualOrdinal(con.CONID)}`
          const references = (con.CONReferences ?? []).filter(Boolean)
          const referencesTooLong = references.length > SDBH_MAX_REFERENCES
          const referenceMeta = references.length === 0
            ? {}
            : referencesTooLong
              ? { referencesNotImported: true as const, referenceCount: references.length }
              : { references, referenceCount: references.length }
          if (referencesTooLong) {
            notImported.push({ conId: con.CONID, lemma: entry.Lemma, field: "references", count: references.length })
          }
          let conFirst = true
          for (const field of SDBH_FIELDS) {
            const value = senseFieldValue(conSense, field)
            if (!value) continue
            strings.push({
              id: sdbhConCellId(con.CONID, field),
              original: value,
              translated: "",
              context: [
                entry.Lemma,
                SDBH_CONTEXTUAL_TAG,
                collocations.join(", "),
                forms.join(", "),
                conDomains.map((d) => d.label).filter(Boolean).join(", "),
                FIELD_LABEL[field],
              ].filter(Boolean).join(" · "),
              group: conGroup,
              milestone,
              paragraphStart: conFirst,
              type: "text",
              metadata: {
                tags: [entry.Lemma, SDBH_CONTEXTUAL_TAG, SDBH_FIELD_TAG[field]],
                sdbh: {
                  layer: "contextual",
                  conId: con.CONID,
                  lexId: meaning.LEXID,
                  field,
                  lemma: entry.Lemma,
                  ...(con.CONType ? { contextualType: con.CONType } : {}),
                  ...(collocations.length ? { collocations } : {}),
                  ...(forms.length ? { forms } : {}),
                  ...referenceMeta,
                  ...(conDomains.length ? { domains: conDomains } : {}),
                },
              },
            })
            conFirst = false
          }
          if (!conFirst) contextualMeaningCount += 1
        }
      }
    }
  }

  const files: SdbhParsedFile[] = [...byLetter.entries()]
    .filter(([, strings]) => strings.length > 0)
    .map(([letter, strings]) => ({ name: `SDBH ${letter}`, strings }))

  const domainStrings: TranslatableString[] = []
  const pushDomain = (prefix: string, kind: string, tag: string, code: string, label: string) => {
    domainStrings.push({
      id: `${prefix}${code}`,
      original: label,
      translated: "",
      context: `${kind} ${code}`,
      group: code,
      paragraphStart: true,
      type: "text",
      metadata: { tags: [tag], sdbh: { domainCode: code, domainKind: kind } },
    })
  }
  const sorted = (map: Map<string, string>) =>
    [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
  for (const [code, label] of sorted(domains)) {
    pushDomain(SDBH_DOMAIN_CELL_PREFIX, "domain", "Domain", code, label)
  }
  for (const [code, label] of sorted(coreDomains)) {
    pushDomain(SDBH_COREDOMAIN_CELL_PREFIX, "core-domain", "Core domain", code, label)
  }
  for (const [code, label] of sorted(contextualDomains)) {
    pushDomain(SDBH_CONDOMAIN_CELL_PREFIX, "contextual-domain", "Contextual domain", code, label)
  }

  return {
    files,
    domainFile: { name: "SDBH Semantic domains", strings: domainStrings },
    senseCount,
    contextualMeaningCount,
    entryCount: entries.length,
    notImported,
  }
}

// ---------------------------------------------------------------------------
// Localized extraction — a localized edition's JSON → cellId → text map, for
// pre-filling the target column (and for identity round-trip checks).
// ---------------------------------------------------------------------------

export interface SdbhLocalizedStrings {
  /** cellId (sdbh-<LEXID>-<field>, sdbh-con-<CONID>-<field>, and domain-label
   *  ids) → localized text. Empty fields are absent — a blank must never clear
   *  a translation. */
  byCellId: Map<string, string>
  languageCode: string | null
}

export function extractSdbhLocalized(entries: SdbhEntry[]): SdbhLocalizedStrings {
  const byCellId = new Map<string, string>()
  let languageCode: string | null = null

  const putSense = (sense: SdbhSense | undefined, idFor: (field: SdbhField) => string) => {
    if (!sense) return
    if (!languageCode && sense.LanguageCode) languageCode = sense.LanguageCode
    for (const field of SDBH_FIELDS) {
      const value = senseFieldValue(sense, field)
      if (value) byCellId.set(idFor(field), value)
    }
  }
  const putDomains = (prefix: string, list: SdbhDomain[] | null | undefined) => {
    for (const d of list ?? []) {
      if (d.DomainCode && d.Domain && !byCellId.has(`${prefix}${d.DomainCode}`)) {
        byCellId.set(`${prefix}${d.DomainCode}`, d.Domain)
      }
    }
  }

  for (const entry of entries) {
    for (const bf of entry.BaseForms ?? []) {
      for (const meaning of bf.LEXMeanings ?? []) {
        putSense(meaning.LEXSenses?.[0], (field) => sdbhCellId(meaning.LEXID, field))
        putDomains(SDBH_DOMAIN_CELL_PREFIX, meaning.LEXDomains)
        putDomains(SDBH_COREDOMAIN_CELL_PREFIX, meaning.LEXCoreDomains)
        for (const con of meaning.CONMeanings ?? []) {
          putSense(con.CONSenses?.[0], (field) => sdbhConCellId(con.CONID, field))
          putDomains(SDBH_CONDOMAIN_CELL_PREFIX, con.CONDomains)
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
  /** Rewrite LEXSense/CONSense LanguageCode attributes (needed when
   *  bootstrapping a new language from another edition's skeleton). Omit to
   *  preserve the skeleton's. */
  languageCode?: string
  /** Also rewrite localized domain LABEL text (codes never change). Uses the
   *  sdbh-domain-<code> / sdbh-coredomain-<code> / sdbh-condomain-<code> ids
   *  from byCellId. Off by default: identity round-trips already carry the
   *  right labels. */
  rewriteDomainLabels?: boolean
}

export interface SdbhInjectResult {
  xml: string
  sensesInjected: number
  /** Contextual meanings whose CONSense was regenerated or newly created. */
  contextualSensesInjected: number
  /** Glosses cells whose text contained ";" inside a gloss — none exist in the
   *  shipped corpus; a translator-introduced one splits on export, so we surface it. */
  warnings: string[]
}

const DEFAULT_SENSE_INDENT = "                "

/** The four translatable children of a LEXSense/CONSense, in canonical order. */
function senseChildrenXml(
  indent: string,
  get: (field: SdbhField) => string,
  meaningId: string,
  warnings: string[],
): string[] {
  const el = (tag: string, value: string) =>
    value ? `${indent}<${tag}>${escapeXmlText(value)}</${tag}>` : `${indent}<${tag} />`
  const glosses = splitGlosses(get("glosses"))
  if (glosses.some((g) => g.includes(";"))) {
    warnings.push(`sense ${meaningId}: semicolon inside a gloss — export splits on ";"`)
  }
  const glossesXml = glosses.length
    ? `${indent}<Glosses>\n${glosses.map((g) => `${indent}  <Gloss>${escapeXmlText(g)}</Gloss>`).join("\n")}\n${indent}</Glosses>`
    : `${indent}<Glosses />`
  return [
    el("DefinitionLong", get("definitionLong")),
    el("DefinitionShort", get("definitionShort")),
    glossesXml,
    el("Comments", get("comments")),
  ]
}

/** Regenerate the body of an existing `<LEXSense>`/`<CONSense>` element. */
function regenerateSense(
  sOpen: string,
  sBody: string,
  sClose: string,
  get: (field: SdbhField) => string,
  meaningId: string,
  opts: SdbhInjectOptions,
  warnings: string[],
): string {
  // Indentation: derive from the first child line of the sense body.
  const indentMatch = /\n(\s*)</.exec(sBody)
  const indent = indentMatch ? indentMatch[1] : DEFAULT_SENSE_INDENT
  const closeIndent = indent.slice(0, Math.max(0, indent.length - 2))
  let newOpen = sOpen
  if (opts.languageCode) {
    newOpen = newOpen.replace(/LanguageCode="[^"]*"/, `LanguageCode="${opts.languageCode}"`)
  }
  return [
    newOpen,
    ...senseChildrenXml(indent, get, meaningId, warnings),
    `${closeIndent}${sClose}`,
  ].join("\n")
}

/**
 * Rewrite each `<LEXSense>` block's translatable children from `byCellId`,
 * keyed by the enclosing `<LEXMeaning Id>`, and each `<CONSense>` block's
 * keyed by its `<ContextualMeaning Id>`. A contextual meaning whose skeleton
 * has no sense yet (`<CONSenses />` — the norm in localized editions) gets one
 * created when a translation exists for it, and is left byte-identical
 * otherwise. Whitespace, attributes, and every other element are preserved.
 */
export function injectSdbhXml(skeletonXml: string, opts: SdbhInjectOptions): SdbhInjectResult {
  const warnings: string[] = []
  let sensesInjected = 0
  let contextualSensesInjected = 0

  // Per-LEXMeaning: find its (single) LEXSense element and regenerate children.
  // The corpus is machine-generated and regular: LEXMeaning opening tags carry
  // Id="..." and each contains at most one <LEXSenses> list with one <LEXSense>.
  let out = skeletonXml.replace(
    /(<LEXMeaning Id="(\d+)"[^>]*>)([\s\S]*?)(<\/LEXMeaning>)/g,
    (_whole, open: string, lexId: string, body: string, close: string) => {
      const get = (field: SdbhField) => opts.byCellId.get(sdbhCellId(lexId, field)) ?? ""
      const rewritten = body.replace(
        // LEXSense: self-closing never occurs (children always serialized).
        /(<LEXSense\b[^>]*>)([\s\S]*?)(<\/LEXSense>)/,
        (_sWhole, sOpen: string, sBody: string, sClose: string) => {
          sensesInjected += 1
          return regenerateSense(sOpen, sBody, sClose, get, lexId, opts, warnings)
        },
      )
      return open + rewritten + close
    },
  )

  // Per-ContextualMeaning. A new CONSense needs a LanguageCode: the requested
  // one, else whatever the skeleton's senses already carry.
  const skeletonLanguage = /LanguageCode="([^"]*)"/.exec(skeletonXml)?.[1] ?? ""
  const newSenseLanguage = opts.languageCode ?? skeletonLanguage
  out = out.replace(
    /(<ContextualMeaning Id="(\d+)"[^>]*>)([\s\S]*?)(<\/ContextualMeaning>)/g,
    (whole, open: string, conId: string, body: string, close: string) => {
      const get = (field: SdbhField) => opts.byCellId.get(sdbhConCellId(conId, field)) ?? ""
      if (/<CONSense\b[^>]*>/.test(body)) {
        const rewritten = body.replace(
          /(<CONSense\b[^>]*>)([\s\S]*?)(<\/CONSense>)/,
          (_sWhole, sOpen: string, sBody: string, sClose: string) => {
            contextualSensesInjected += 1
            return regenerateSense(sOpen, sBody, sClose, get, conId, opts, warnings)
          },
        )
        return open + rewritten + close
      }
      if (!SDBH_FIELDS.some((field) => get(field))) return whole
      const rewritten = body.replace(/([ \t]*)<CONSenses \/>/, (_m, listIndent: string) => {
        contextualSensesInjected += 1
        const senseIndent = `${listIndent}  `
        const childIndent = `${senseIndent}  `
        return [
          `${listIndent}<CONSenses>`,
          `${senseIndent}<CONSense LanguageCode="${newSenseLanguage}" LastEdited="" LastEditedBy="">`,
          ...senseChildrenXml(childIndent, get, conId, warnings),
          `${senseIndent}</CONSense>`,
          `${listIndent}</CONSenses>`,
        ].join("\n")
      })
      return open + rewritten + close
    },
  )

  if (opts.rewriteDomainLabels) {
    out = out.replace(
      /(<(LEXDomain|LEXSubDomain|LEXCoreDomain|CONDomain) Code="([^"]*)"[^>]*>)([^<]*)(<\/\2>)/g,
      (whole, open: string, tag: string, code: string, _label: string, close: string) => {
        const prefix = tag === "LEXCoreDomain"
          ? SDBH_COREDOMAIN_CELL_PREFIX
          : tag === "CONDomain"
            ? SDBH_CONDOMAIN_CELL_PREFIX
            : SDBH_DOMAIN_CELL_PREFIX
        const localized = opts.byCellId.get(`${prefix}${code}`)
        return localized ? `${open}${escapeXmlText(localized)}${close}` : whole
      },
    )
  }

  return { xml: out, sensesInjected, contextualSensesInjected, warnings }
}
