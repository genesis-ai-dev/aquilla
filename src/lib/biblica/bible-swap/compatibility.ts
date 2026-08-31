/**
 * Bible Swap compatibility report.
 *
 * Before committing to a swap, the user is shown how well the Bible IDML they
 * picked lines up with the study volumes they are exporting: book/chapter/verse
 * overlap, the worst-mismatched books, and what the versification plan would do
 * (verses mapped, removed, inserted, Psalm chapter shifts).
 *
 * Ported from codex's `bibleSwapCompatibility.ts`. The scoring is unchanged;
 * the I/O is not. Codex read files through `vscode.workspace.fs` and fanned the
 * indexing across `worker_threads`. Here the caller supplies IDML bytes it has
 * already fetched (Aquilla keeps imported originals in R2), and the analysis is
 * a plain async function so it can run inline or inside the swap worker.
 */

import JSZip from "jszip"
import { PSA_BOOK_CODE } from "./index"
import {
  buildCompatVerseIndex,
  compatIndexHasPsalmSubheaderV1,
  type CompatVerseIndex,
} from "./compatVerseIndex"
import { buildBibleVerseIndex, listVerseKeys } from "./surgicalSwap"
import {
  buildVersificationPlanFromIndices,
  collectVersificationChanges,
  mergeVersificationChanges,
  type BibleSwapVersificationChanges,
} from "./versificationPlan"

export interface BibleSwapVersificationPlanSummary {
  versesMapped: number
  versesRemoved: number
  versesInserted: number
  psalmChapterShifts: number
  projectedVerseMatchPercent: number
}

export interface BibleSwapBookMismatch {
  book: string
  missing: number
  extra: number
}

export interface BibleSwapCompatibilityReport {
  bibleFileName: string
  booksFound: number
  booksExpected: number
  chaptersFound: number
  chaptersExpected: number
  versesMatched: number
  versesExpected: number
  hasPsalms: boolean
  perBookMismatches: BibleSwapBookMismatch[]
  versificationPlan?: BibleSwapVersificationPlanSummary
  versificationChanges?: BibleSwapVersificationChanges
}

export interface BibleSwapAnalysisProgress {
  stage: "loading" | "indexing" | "planning" | "summarizing"
  percent: number
  message: string
}

export type BibleSwapProgressCallback = (progress: BibleSwapAnalysisProgress) => void

/** A study volume being exported, paired with the bytes of its imported IDML. */
export interface StudyVolumeSource {
  fileName: string
  idmlData: Uint8Array
}

function isZipArchive(data: Uint8Array | undefined): boolean {
  return !!data && data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b
}

function toTightZipBytes(data: Uint8Array): Uint8Array {
  return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
    ? data
    : new Uint8Array(data)
}

/** Scripture lives in the largest `Stories/*.xml`; prefer recorded sizes. */
async function readLargestStoryXml(zip: JSZip): Promise<string | null> {
  const storyNames = Object.keys(zip.files).filter(
    (name) => name.startsWith("Stories/") && name.endsWith(".xml"),
  )

  let bestKey: string | null = null
  let bestSize = -1
  for (const name of storyNames) {
    const file = zip.files[name]
    if (file.dir) continue
    const size =
      (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ??
      -1
    if (size > bestSize) {
      bestSize = size
      bestKey = name
    }
  }

  if (bestKey) return zip.file(bestKey)?.async("text") ?? null

  let bestText: string | null = null
  for (const name of storyNames) {
    const file = zip.file(name)
    if (!file) continue
    const text = await file.async("text")
    if (!bestText || text.length > bestText.length) bestText = text
  }
  return bestText
}

/**
 * Read the main Story XML out of IDML bytes. Names the file on failure — a
 * stored original whose bytes were mangled still starts with "PK", and the user
 * otherwise cannot tell which file to re-import.
 */
export async function loadStoryXmlFromIdmlBytes(
  data: Uint8Array,
  fileLabel: string,
): Promise<string> {
  if (!isZipArchive(data)) {
    throw new Error(`"${fileLabel}" is not a valid IDML (ZIP) archive. Expected a .idml file.`)
  }

  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(toTightZipBytes(data))
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(
      `"${fileLabel}" (${data.length} bytes) could not be read as an IDML archive: ${detail}`,
      { cause: err },
    )
  }

  const storyXml = await readLargestStoryXml(zip)
  if (!storyXml) {
    throw new Error(
      `No Stories/*.xml entries found inside "${fileLabel}". The file may be empty or corrupted.`,
    )
  }
  return storyXml
}

function mergeCompatIndexes(indexes: readonly CompatVerseIndex[]): Map<string, Set<string>> {
  const merged = new Map<string, Set<string>>()
  for (const index of indexes) {
    for (const [book, verses] of index.byBook.entries()) {
      let set = merged.get(book)
      if (!set) {
        set = new Set()
        merged.set(book, set)
      }
      for (const cv of verses) set.add(cv)
    }
  }
  return merged
}

/**
 * Score how well a Bible story aligns with the study stories being exported.
 * Pure over already-extracted Story XML so it can run anywhere.
 */
export function scoreBibleSwapCompatibility(
  bibleFileName: string,
  bibleStoryXml: string,
  studyStoryXmls: readonly string[],
): BibleSwapCompatibilityReport {
  const bibleIndex = buildCompatVerseIndex(bibleStoryXml, { indexBibleSubheaders: true })
  const studyByBook = mergeCompatIndexes(
    studyStoryXmls.map((xml) => buildCompatVerseIndex(xml)),
  )
  const bibleByBook = bibleIndex.byBook

  let booksExpected = 0
  let booksFound = 0
  let versesExpected = 0
  let versesMatched = 0
  let hasPsalms = false
  const chapterSetExpected = new Set<string>()
  const chapterSetFound = new Set<string>()
  const perBookMismatches: BibleSwapBookMismatch[] = []

  /** Psalms shift by one where the Bible sets the superscription as verse 1. */
  const studyVerseMatchesBible = (
    book: string,
    chapter: string,
    verse: string,
    bibleVerses: Set<string> | undefined,
  ): boolean => {
    if (!bibleVerses) return false
    if (book === PSA_BOOK_CODE) {
      const offset = compatIndexHasPsalmSubheaderV1(bibleIndex, chapter) ? 1 : 0
      return bibleVerses.has(`${chapter}|${String(parseInt(verse, 10) + offset)}`)
    }
    return bibleVerses.has(`${chapter}|${verse}`)
  }

  for (const [book, studyVerses] of studyByBook.entries()) {
    booksExpected++
    if (book === PSA_BOOK_CODE) hasPsalms = true

    const bibleVerses = bibleByBook.get(book)
    if (bibleVerses && bibleVerses.size > 0) booksFound++

    let missing = 0
    for (const cv of studyVerses) {
      versesExpected++
      const [chapter, verse] = cv.split("|")
      chapterSetExpected.add(`${book}|${chapter}`)
      if (studyVerseMatchesBible(book, chapter, verse, bibleVerses)) {
        versesMatched++
        chapterSetFound.add(`${book}|${chapter}`)
      } else {
        missing++
      }
    }

    let extra = 0
    if (bibleVerses) {
      for (const cv of bibleVerses) if (!studyVerses.has(cv)) extra++
    }
    if (missing > 0 || extra > 0) perBookMismatches.push({ book, missing, extra })
  }

  perBookMismatches.sort((a, b) => b.missing + b.extra - (a.missing + a.extra))

  const report: BibleSwapCompatibilityReport = {
    bibleFileName,
    booksFound,
    booksExpected,
    chaptersFound: chapterSetFound.size,
    chaptersExpected: chapterSetExpected.size,
    versesMatched,
    versesExpected,
    hasPsalms,
    perBookMismatches,
  }

  if (studyStoryXmls.length === 0) return report

  const fullBibleIndex = buildBibleVerseIndex(bibleStoryXml)
  let planMapped = 0
  let planRemoved = 0
  let planInserted = 0
  let planPsalmShifts = 0
  let planExpected = 0
  const allChanges: BibleSwapVersificationChanges[] = []

  for (const studyStoryXml of studyStoryXmls) {
    const studyIndex = buildBibleVerseIndex(studyStoryXml)
    const plan = buildVersificationPlanFromIndices(studyStoryXml, studyIndex, fullBibleIndex)
    planExpected += listVerseKeys(studyIndex).length
    planMapped += plan.stats.versesMapped
    planRemoved += plan.stats.versesRemoved
    planInserted += plan.stats.versesInserted
    planPsalmShifts = Math.max(planPsalmShifts, plan.stats.psalmChapterShifts)
    allChanges.push(collectVersificationChanges(plan, studyIndex, fullBibleIndex))
  }

  report.versificationPlan = {
    versesMapped: planMapped,
    versesRemoved: planRemoved,
    versesInserted: planInserted,
    psalmChapterShifts: planPsalmShifts,
    projectedVerseMatchPercent:
      planExpected > 0 ? Math.round((planMapped / planExpected) * 10000) / 100 : 100,
  }
  report.versificationChanges = mergeVersificationChanges(allChanges)

  return report
}

/**
 * Compatibility between a chosen Bible IDML and the study volumes selected for
 * export. Study volumes that cannot be read are skipped rather than failing the
 * whole report — the swap can still proceed for the rest.
 */
export async function analyzeBibleSwapCompatibility(
  bibleFileName: string,
  bibleIdmlData: Uint8Array,
  studyVolumes: readonly StudyVolumeSource[],
  onProgress?: BibleSwapProgressCallback,
): Promise<BibleSwapCompatibilityReport> {
  onProgress?.({
    stage: "loading",
    percent: 5,
    message: "Reading Bible and study IDML files…",
  })

  const bibleStoryXml = await loadStoryXmlFromIdmlBytes(bibleIdmlData, bibleFileName)

  const studyStoryXmls: string[] = []
  for (const volume of studyVolumes) {
    try {
      studyStoryXmls.push(await loadStoryXmlFromIdmlBytes(volume.idmlData, volume.fileName))
    } catch (err) {
      console.warn(
        `[BibleSwapCompatibility] Skipping "${volume.fileName}": ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  onProgress?.({
    stage: "indexing",
    percent: 25,
    message: `Loaded Bible + ${studyStoryXmls.length} study file(s)`,
  })

  const report = scoreBibleSwapCompatibility(bibleFileName, bibleStoryXml, studyStoryXmls)

  onProgress?.({ stage: "summarizing", percent: 100, message: "Analysis complete" })
  return report
}
