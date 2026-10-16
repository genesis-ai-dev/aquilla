// File-level scans of check pack B (AQU-1699; design doc §7.2 P2, §7.7 X3).
// Like ./scans.ts, they compare cells, so they run in "Check file" only.
//
//   P2  one name across the file: the cells that name X in the source
//       should render X one way. Cells are grouped by the name forms the
//       source uses there (Σίμων Πέτρος is not Κηφᾶς), and in each group a
//       cell is reported when its translation has a known variant of X's name
//       other than the group's usual one, or none of X's known names at all.
//   X3  a quotation repeated in the file (the same Greek words, four or more)
//       is rendered alike: the later cell is reported when its rendering
//       shares too few words with the first one's (token Jaccard).
//
// Pure: cells in file order with their text, their compiled expectations and
// the book's layers. Findings carry the cell they belong to and codes, never
// sentences. Relative imports only, no DOM: shared with the workers.

import type { LanguageProfile } from '../language-profile'
import { nameSpans } from './name-match'
import type { NameTable } from './participant-types'
import { scanQuotes } from './quote-scan'
import { expandCellRefs, wordRef } from './refs'
import type { BibleScanFinding } from './scans'
import {
  BIBLE_CHECK_DEFAULT_SEVERITY,
  type BibleCheckEvidence,
  type BibleCheckReason,
  type BibleCheckSpan,
  type CellExpectation,
  type TextLayerInput,
  type VoicesLayerInput,
} from './types'
import { maskUsfm } from './usfm-mask'

/** What the pack-B scans read from a cell. */
export interface TextScanCell {
  id: string
  globalReferences?: readonly string[]
  /** The cell's translation. */
  text: string
}

/** X3 reports a repeated quotation whose renderings share fewer words than this. */
export const QUOTATION_SIMILARITY = 0.5
/** X3 compares quotations of at least this many Greek words. */
export const MIN_QUOTATION_WORDS = 4

function finding(
  cellId: string,
  code: 'bkp:P2' | 'bkp:X3',
  reason: BibleCheckReason,
  params: Record<string, string>,
  evidence: BibleCheckEvidence,
  spans: readonly BibleCheckSpan[] = [],
): BibleScanFinding {
  return { cellId, code, reason, params, severity: BIBLE_CHECK_DEFAULT_SEVERITY[code], spans, approximate: false, evidence }
}

// ── P2: one name across the file ────────────────────────────────────────────

/** Every known rendering of an entity's name in this table: decisions, terminology, forms. */
function knownVariants(table: NameTable, entity: string): string[] {
  const out: string[] = []
  const add = (value: string) => {
    if (value && !out.includes(value)) out.push(value)
  }
  for (const name of table.names.get(entity) ?? []) name.variants.forEach(add)
  for (const list of table.forms.get(entity)?.values() ?? []) for (const name of list) name.renderings.forEach(add)
  return out
}

interface Occurrence {
  cellId: string
  refs: readonly string[]
  /** The variants the translation has, longest first; a variant inside a longer one is dropped. */
  found: { variant: string; span: BibleCheckSpan }[]
}

function variantsIn(text: string, variants: readonly string[]): Occurrence['found'] {
  const found: Occurrence['found'] = []
  for (const variant of [...variants].sort((a, b) => b.length - a.length)) {
    for (const span of nameSpans(text, variant)) {
      if (!found.some((f) => f.span.start <= span.start && span.end <= f.span.end)) found.push({ variant, span })
    }
  }
  return found
}

/** The rendering most cells of a group use; a tie goes to the agreed name's own order. */
function usual(occurrences: readonly Occurrence[], variants: readonly string[]): string | null {
  const counts = new Map<string, number>()
  for (const occurrence of occurrences) {
    for (const variant of new Set(occurrence.found.map((f) => f.variant))) counts.set(variant, (counts.get(variant) ?? 0) + 1)
  }
  let best: string | null = null
  for (const variant of variants) {
    if ((counts.get(variant) ?? 0) > (best === null ? 0 : (counts.get(best) ?? 0))) best = variant
  }
  return best
}

export function scanNameConsistency(
  cells: readonly TextScanCell[],
  expectations: ReadonlyMap<string, CellExpectation>,
): BibleScanFinding[] {
  // entity → name-form signature → occurrences, in file order.
  const groups = new Map<string, Map<string, Occurrence[]>>()
  let table: NameTable | null = null
  for (const cell of cells) {
    const participants = expectations.get(cell.id)?.participants
    if (!participants || cell.text.trim() === '') continue
    table ??= participants.names
    const text = maskUsfm(cell.text)
    const lemmas = new Map<string, Set<string>>()
    for (const m of participants.named) lemmas.set(m.entity, (lemmas.get(m.entity) ?? new Set()).add(m.lemma))
    for (const [entity, forms] of lemmas) {
      const variants = knownVariants(participants.names, entity)
      if (variants.length === 0) continue
      const signature = [...forms].sort().join('+')
      const byForm = groups.get(entity) ?? new Map<string, Occurrence[]>()
      const list = byForm.get(signature) ?? []
      list.push({ cellId: cell.id, refs: expectations.get(cell.id)?.refs ?? [], found: variantsIn(text, variants) })
      byForm.set(signature, list)
      groups.set(entity, byForm)
    }
  }
  if (!table) return []
  const findings: BibleScanFinding[] = []
  for (const [entity, byForm] of groups) {
    const variants = knownVariants(table, entity)
    const name = labelOf(table, entity)
    for (const occurrences of byForm.values()) {
      const main = usual(occurrences, variants)
      // Out of line with the file: without a usual rendering there is nothing to be out of line with (P1 reads each cell).
      if (!main) continue
      for (const occurrence of occurrences) {
        const evidence: BibleCheckEvidence = { kind: 'name-variants', refs: occurrence.refs, entity }
        if (occurrence.found.length === 0) {
          findings.push(finding(occurrence.cellId, 'bkp:P2', 'name-variant-none', { name, usual: main }, evidence))
        } else if (!occurrence.found.some((f) => f.variant === main)) {
          const first = occurrence.found[0]
          findings.push(
            finding(occurrence.cellId, 'bkp:P2', 'name-variant-different', { name, found: first.variant, usual: main }, evidence, [first.span]),
          )
        }
      }
    }
  }
  return findings
}

function labelOf(table: NameTable, entity: string): string {
  const labels = Object.hasOwn(table.entities, entity) ? table.entities[entity].labels : undefined
  return (labels && (labels.eng ?? Object.values(labels)[0])) || entity
}

// ── X3: a repeated quotation is rendered alike ──────────────────────────────

/** Greek text for comparing: no accents or breathings, lower case, final sigma as σ, letters only. */
function greekKey(word: string): string {
  return word.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ς/gu, 'σ').replace(/[^\p{L}]/gu, '')
}

function tokens(text: string): Set<string> {
  return new Set(text.normalize('NFC').toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) ?? [])
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let shared = 0
  for (const token of a) if (b.has(token)) shared++
  return shared / (a.size + b.size - shared)
}

/** A clause this short can match anything ("I tell you"); it says nothing about one rendering. */
const MIN_CLAUSE_WORDS = 3

/**
 * The cell's whole text, each quotation in it, and each clause of three words
 * or more: one of them renders the repeated words ("they have received their
 * reward" inside a longer verse).
 */
function renderings(text: string, profile: LanguageProfile): string[] {
  const out = [text]
  const marks = profile.quoteMarks
  if (marks) {
    const { tokens: marksFound } = scanQuotes(text, marks, 0)
    marksFound.forEach((token, i) => {
      if (token.kind !== 'open') return
      const close = marksFound.slice(i + 1).find((t) => (t.kind === 'close' || t.kind === 'stray-close') && t.depth === token.depth)
      out.push(text.slice(token.end, close ? close.start : text.length))
    })
  }
  for (const clause of text.split(/[.,;:!?¿¡()"“”‘’«»]+/u)) if (tokens(clause).size >= MIN_CLAUSE_WORDS) out.push(clause)
  return out
}

/** The best word overlap between any rendering of one cell and any of the other's. */
function similarity(a: readonly string[], b: readonly string[]): number {
  let best = 0
  for (const x of a) for (const y of b) best = Math.max(best, jaccard(tokens(x), tokens(y)))
  return best
}

export function scanRepeatedQuotations(
  cells: readonly TextScanCell[],
  voices: Pick<VoicesLayerInput, 'speeches'>,
  text: TextLayerInput,
  profile: LanguageProfile,
): BibleScanFinding[] {
  // Every word of the book in reading order, and the cell each verse belongs to.
  const order: string[] = []
  for (const ids of Object.values(text.verses)) order.push(...ids)
  order.sort()
  const cellOfRef = new Map<string, TextScanCell>()
  let book: string | null = null
  for (const cell of cells) {
    const verses = expandCellRefs(cell.globalReferences ?? [])
    if (!verses) continue
    book ??= verses.book
    for (const ref of verses.verses) if (!cellOfRef.has(ref)) cellOfRef.set(ref, cell)
  }
  if (!book) return []
  const lowerBound = (id: string) => {
    let lo = 0
    let hi = order.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (order[mid] < id) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  const repeated = new Map<string, { cell: TextScanCell; ref: string }[]>()
  for (const speech of voices.speeches) {
    const words = order.slice(lowerBound(speech.from), lowerBound(speech.to) + 1).filter((id) => id <= speech.to)
    const key = words.map((id) => greekKey(Object.hasOwn(text.words, id) ? (text.words[id].text ?? '') : '')).filter(Boolean)
    if (key.length < MIN_QUOTATION_WORDS) continue
    const first = cellOfRef.get(wordRef(book, speech.from))
    // A quotation over several cells has no single cell to compare.
    if (!first || cellOfRef.get(wordRef(book, speech.to)) !== first) continue
    const list = repeated.get(key.join(' ')) ?? []
    if (!list.some((occurrence) => occurrence.cell.id === first.id)) list.push({ cell: first, ref: wordRef(book, speech.from) })
    repeated.set(key.join(' '), list)
  }

  const findings: BibleScanFinding[] = []
  for (const occurrences of repeated.values()) {
    if (occurrences.length < 2) continue
    const [model, ...later] = occurrences
    if (model.cell.text.trim() === '') continue
    const modelRenderings = renderings(maskUsfm(model.cell.text), profile)
    for (const occurrence of later) {
      if (occurrence.cell.text.trim() === '') continue
      const score = similarity(renderings(maskUsfm(occurrence.cell.text), profile), modelRenderings)
      if (score >= QUOTATION_SIMILARITY) continue
      findings.push(
        finding(occurrence.cell.id, 'bkp:X3', 'quotation-differs', { other: model.ref, similarity: score.toFixed(2) }, {
          kind: 'repeated-quotation',
          refs: [occurrence.ref],
          other: model.ref,
          similarity: Number(score.toFixed(2)),
        }),
      )
    }
  }
  return findings
}
