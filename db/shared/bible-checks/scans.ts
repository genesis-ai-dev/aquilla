// File-level Bible data scans (AQU-1697; design doc §4.6 "consistency scans",
// §7.6): a heading where each passage starts (S1), and the file's verses
// against the pack's (S8). Both need every cell of the file in order, so they
// run in "Check file", never as a cell's live check.
//
// Pure: cells in file order, the book's structure layer (already mapped into
// the project's versification by the caller's hook) and the Language profile.
// Findings carry the cell they belong to and codes, never sentences.
//
// Relative imports only, no DOM: shared with the workers.

import type { LanguageProfile } from '../language-profile'
import { expandCellRefs, wordNumber, wordRef } from './refs'
import {
  BIBLE_CHECK_DEFAULT_SEVERITY,
  type BibleCheckEvidence,
  type BibleCheckFinding,
  type BibleCheckReason,
  type StructureLayerInput,
} from './types'
import { isVariantVerse } from './variants'

/** What a scan reads from a cell. A CellData fits. */
export interface ScanCellInput {
  id: string
  /** "heading" for a section heading (USFM \s, \ms); verse cells are "text". */
  type?: string
  globalReferences?: readonly string[]
}

export interface BibleScanFinding extends BibleCheckFinding {
  cellId: string
}

function scanFinding(
  cellId: string,
  code: 'bkp:S1' | 'bkp:S8',
  reason: BibleCheckReason,
  evidence: BibleCheckEvidence,
): BibleScanFinding {
  return {
    cellId,
    code,
    reason,
    params: {},
    severity: BIBLE_CHECK_DEFAULT_SEVERITY[code],
    spans: [],
    approximate: false,
    evidence,
  }
}

/** A heading's structural ref names its marker: "JHN 4:s1:2", "JHN:ms:1" (src/lib/parsers/usfm-lossless.ts). */
const MARKER_REF = /:([a-z]+)\d*:\d+$/i
/** Section headings. \r (parallel passages), \sr, \mr, \d and the introduction's headings are not. */
const SECTION_MARKERS: ReadonlySet<string> = new Set(['s', 'ms'])

function isSectionHeading(cell: ScanCellInput): boolean {
  if (cell.type !== 'heading') return false
  const marker = MARKER_REF.exec(cell.globalReferences?.[0] ?? '')?.[1]
  // Without a structural ref (a DCS import gives "JHN 4"), every heading counts.
  return marker === undefined || SECTION_MARKERS.has(marker.toLowerCase())
}

// ── S1: a heading where each passage starts, and none inside one ────────────

/**
 * With `headings: "pericope"`, each OpenText pericope (segment) that starts
 * at the beginning of a verse should have a heading just before that verse's
 * cell, and a heading should not stand before a verse in the middle of a
 * pericope. Info: OpenText's pericopes are one reasonable division, not the
 * only one.
 */
export function scanHeadings(
  cells: readonly ScanCellInput[],
  structure: StructureLayerInput,
  profile: LanguageProfile,
): BibleScanFinding[] {
  if (profile.headings !== 'pericope' || !structure.segments) return []
  const book = cells.map((c) => expandCellRefs(c.globalReferences ?? [])?.book).find(Boolean)
  if (!book) return []
  // Verses that start a pericope (where a heading must go), and verses where
  // one may go because the pericope starts mid-verse, before or after it.
  const starts = new Map<string, string>()
  const welcome = new Set<string>()
  const pericopeOf = new Map<string, string>()
  const packVerses = Object.keys(structure.verses)
  for (const segment of structure.segments) {
    const ref = wordRef(book, segment.from)
    if (wordNumber(segment.from) === 1) starts.set(ref, segment.title)
    welcome.add(ref)
    const next = packVerses[packVerses.indexOf(ref) + 1]
    if (wordNumber(segment.from) > 1 && next) welcome.add(next)
  }
  for (const segment of structure.segments) {
    const first = packVerses.indexOf(wordRef(book, segment.from))
    const last = packVerses.indexOf(wordRef(book, segment.to))
    for (let i = first; i >= 0 && i <= last; i++) if (!pericopeOf.has(packVerses[i])) pericopeOf.set(packVerses[i], segment.title)
  }

  const findings: BibleScanFinding[] = []
  let heading: string | null = null
  for (const cell of cells) {
    if (isSectionHeading(cell)) {
      heading = cell.id
      continue
    }
    const verses = expandCellRefs(cell.globalReferences ?? [])
    if (!verses || verses.book !== book) continue
    const ref = verses.verses[0]
    const title = starts.get(ref)
    if (title !== undefined && heading === null) {
      findings.push(scanFinding(cell.id, 'bkp:S1', 'heading-missing', { kind: 'pericope', refs: [ref], title }))
    } else if (heading !== null && !welcome.has(ref) && pericopeOf.has(ref)) {
      findings.push(
        scanFinding(heading, 'bkp:S1', 'heading-inside-pericope', {
          kind: 'pericope',
          refs: [ref],
          title: pericopeOf.get(ref) ?? '',
        }),
      )
    }
    heading = null
  }
  return findings
}

// ── S8: the file's verses against the pack's ────────────────────────────────

/**
 * Verses the Macula SBLGNT data lacks although the critical text prints
 * them: its Romans ends at 16:24, without the doxology (bible-wiki
 * docs/superpowers/research/2026-10-05-bible-knowledge-layer/macula.md,
 * "Verse sets"). A cell for them is not a versification error.
 */
const PACK_GAPS: ReadonlySet<string> = new Set(['ROM 16:25', 'ROM 16:26', 'ROM 16:27'])

const chapterOf = (ref: string) => ref.slice(0, ref.lastIndexOf(':'))

/**
 * Cells whose verse the pack does not have (2CO 13:14 in English numbering),
 * and pack verses with no cell in a chapter the file has (3JN 1:15, REV 12:18).
 * The second kind is reported on the cell before the gap. Verses some
 * manuscripts leave out are S6/S7's, not versification.
 */
export function scanVersification(cells: readonly ScanCellInput[], structure: StructureLayerInput): BibleScanFinding[] {
  const packVerses = Object.keys(structure.verses)
  const inPack = new Set(packVerses)
  const findings: BibleScanFinding[] = []
  const cellOf = new Map<string, string>()
  const chapters = new Set<string>()
  let book: string | null = null
  for (const cell of cells) {
    const verses = expandCellRefs(cell.globalReferences ?? [])
    if (!verses) continue
    book ??= verses.book
    const outside = verses.verses.filter((ref) => !inPack.has(ref) && !isVariantVerse(ref) && !PACK_GAPS.has(ref))
    if (outside.length > 0) {
      findings.push(scanFinding(cell.id, 'bkp:S8', 'verse-not-in-pack', { kind: 'versification', refs: outside }))
    }
    for (const ref of verses.verses) {
      if (!cellOf.has(ref)) cellOf.set(ref, cell.id)
      chapters.add(chapterOf(ref))
    }
  }
  // Pack verses with no cell, grouped by the cell before them.
  let anchor: string | null = null
  let missing: string[] = []
  let chapter = ''
  const flush = () => {
    if (anchor && missing.length > 0) {
      findings.push(scanFinding(anchor, 'bkp:S8', 'pack-verse-without-cell', { kind: 'versification', refs: missing }))
    }
    missing = []
  }
  for (const ref of packVerses) {
    if (!book || !ref.startsWith(`${book} `) || !chapters.has(chapterOf(ref))) continue
    if (chapterOf(ref) !== chapter) {
      flush()
      chapter = chapterOf(ref)
      anchor = null
    }
    const cellId = cellOf.get(ref)
    if (cellId) {
      flush()
      anchor = cellId
    } else if (!isVariantVerse(ref)) {
      // A gap at the start of a chapter goes on its first cell.
      anchor ??= firstCellOfChapter(cells, chapter)
      missing.push(ref)
    }
  }
  flush()
  return findings
}

function firstCellOfChapter(cells: readonly ScanCellInput[], chapter: string): string | null {
  for (const cell of cells) {
    const verses = expandCellRefs(cell.globalReferences ?? [])
    if (verses?.verses.some((ref) => chapterOf(ref) === chapter)) return cell.id
  }
  return null
}
