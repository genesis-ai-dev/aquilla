/**
 * Bible Swap post-pass over an exported Study Bible IDML.
 *
 * Ported from codex's `applyBibleSwapPass` / `spliceBibleSwapIntoZip` in
 * `biblicaExporter.ts`. The swap engine itself is unchanged; what differs is the
 * host. Codex ran this in the extension host and fanned stories out across a
 * `worker_threads` pool, whereas Aquilla is a browser SPA, so the caller hands
 * us a single Web Worker runner (see `swap-worker-client.ts`) or lets it run
 * inline on the main thread with shared Bible indexes.
 *
 * The pass is deliberately non-fatal at the call site: a swap failure still
 * leaves a valid notes-only IDML.
 */

import JSZip from "jszip"
import {
  applyBibleSwapWithShared,
  buildBibleSwapSharedResources,
  deserializeVersificationPlan,
  type BibleSwapMode,
  type SerializedVersificationPlan,
  type SwapStats,
} from "./index"

export interface BibleSwapReport {
  replacedVerses: number
  missingFromBible: number
  extraInBibleAppended: number
  psalmSubheaderOffsets: number
  psalmVersesInserted: number
  modifiedStories: number
}

export interface BibleSwapStoryInput {
  storyKey: string
  studyStoryXml: string
}

export interface BibleSwapStoryOutput {
  storyKey: string
  xml: string
  stats: SwapStats
}

/** Off-main-thread runner; omit to swap inline. */
export type BibleSwapParallelRunner = (
  bibleStoryXml: string,
  swapMode: BibleSwapMode,
  stories: BibleSwapStoryInput[],
  serializedPlan?: SerializedVersificationPlan,
  language?: string,
  studyVolume?: string,
) => Promise<BibleSwapStoryOutput[]>

export interface BibleSwapPassOptions {
  swapMode?: BibleSwapMode
  parallelRunner?: BibleSwapParallelRunner
  /** Precomputed plan from a shipped language mapping; skips analyze-at-export. */
  serializedPlan?: SerializedVersificationPlan
  language?: string
  /** Study volume id derived from the file name, e.g. `JOS-EST`. */
  studyVolume?: string
}

/** JSZip needs a view that owns its whole buffer. */
function toTightZipBytes(data: Uint8Array): Uint8Array {
  return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
    ? data
    : new Uint8Array(data)
}

function isZipArchive(data: Uint8Array | undefined): boolean {
  return !!data && data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b
}

function storyKeysOf(zip: JSZip): string[] {
  return Object.keys(zip.files).filter(
    (name) => name.startsWith("Stories/") && name.endsWith(".xml"),
  )
}

/**
 * The Bible's scripture lives in its single largest story. Prefer JSZip's
 * recorded uncompressed size so we don't inflate every story just to measure.
 */
async function largestBibleStoryXml(bibleZip: JSZip): Promise<string> {
  let bestKey: string | null = null
  let bestSize = -1
  for (const name of storyKeysOf(bibleZip)) {
    const file = bibleZip.files[name]
    if (file.dir) continue
    const size =
      (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ??
      -1
    if (size > bestSize) {
      bestSize = size
      bestKey = name
    }
  }

  if (bestKey) {
    const file = bibleZip.file(bestKey)
    if (!file) throw new Error(`Bible Swap: could not read ${bestKey}`)
    return file.async("text")
  }

  // No recorded sizes: inflate and pick the longest by text length.
  let bestText: string | null = null
  for (const name of storyKeysOf(bibleZip)) {
    const file = bibleZip.file(name)
    if (!file) continue
    const text = await file.async("text")
    if (!bestText || text.length > bestText.length) bestText = text
  }
  if (!bestText) throw new Error("Bible Swap: no Stories/*.xml found inside Bible IDML.")
  return bestText
}

interface SwapTotals {
  totalReplaced: number
  totalAppendedExtras: number
  totalMissing: number
  totalPsalmOffsets: number
  totalPsalmInserted: number
  modifiedStories: number
}

function aggregateSwapResult(
  storyKey: string,
  original: string,
  xml: string,
  stats: SwapStats,
  swapMode: BibleSwapMode,
  totals: SwapTotals,
): void {
  if (xml !== original) {
    totals.modifiedStories++
    const modeDetail =
      swapMode === "structure"
        ? `chapters: ${stats.chaptersReplaced ?? 0}, missing-ch: ${stats.chaptersMissing?.length ?? 0}`
        : `psalm-offsets: ${stats.psalmSubheaderOffsets}, psalm-inserted: ${stats.psalmVersesInserted}`
    console.log(
      `[Bible Swap] ${storyKey} (${swapMode}): replaced ${stats.replacedCount} ` +
        `(missing: ${stats.missingFromBible.length}, ${modeDetail}, ` +
        `extras: ${stats.extraInBibleAppended.length}, ` +
        `xml: ${original.length} -> ${xml.length} chars)`,
    )
  }
  totals.totalReplaced += stats.replacedCount
  totals.totalAppendedExtras += stats.extraInBibleAppended.length
  totals.totalMissing += stats.missingFromBible.length
  totals.totalPsalmOffsets += stats.psalmSubheaderOffsets
  totals.totalPsalmInserted += stats.psalmVersesInserted
}

async function spliceBibleSwapIntoZip(
  studyZip: JSZip,
  bibleStoryXml: string,
  options: BibleSwapPassOptions,
): Promise<BibleSwapReport> {
  const { swapMode = "surgical", parallelRunner, serializedPlan, language, studyVolume } = options

  const totals: SwapTotals = {
    totalReplaced: 0,
    totalAppendedExtras: 0,
    totalMissing: 0,
    totalPsalmOffsets: 0,
    totalPsalmInserted: 0,
    modifiedStories: 0,
  }

  const storyInputs: BibleSwapStoryInput[] = []
  for (const storyKey of storyKeysOf(studyZip)) {
    const file = studyZip.file(storyKey)
    if (!file) continue
    storyInputs.push({ storyKey, studyStoryXml: await file.async("text") })
  }

  if (parallelRunner && storyInputs.length > 0) {
    console.log(`[Bible Swap] Off-thread swap across ${storyInputs.length} story file(s)`)
    const results = await parallelRunner(
      bibleStoryXml,
      swapMode,
      storyInputs,
      serializedPlan,
      language,
      studyVolume,
    )
    for (const result of results) {
      const original =
        storyInputs.find((s) => s.storyKey === result.storyKey)?.studyStoryXml ?? ""
      if (result.xml !== original) studyZip.file(result.storyKey, result.xml)
      aggregateSwapResult(result.storyKey, original, result.xml, result.stats, swapMode, totals)
    }
  } else {
    const shared = buildBibleSwapSharedResources(bibleStoryXml, swapMode, language)
    const versificationPlan = serializedPlan
      ? deserializeVersificationPlan(serializedPlan)
      : undefined
    for (const { storyKey, studyStoryXml } of storyInputs) {
      const { xml, stats } = applyBibleSwapWithShared(
        studyStoryXml,
        bibleStoryXml,
        swapMode,
        shared,
        { versificationPlan, language, studyVolume },
      )
      if (xml !== studyStoryXml) studyZip.file(storyKey, xml)
      aggregateSwapResult(storyKey, studyStoryXml, xml, stats, swapMode, totals)
    }
  }

  console.log(
    `[Bible Swap] DONE. Replaced ${totals.totalReplaced} verses across ${totals.modifiedStories} story file(s). ` +
      `Psalm subheader offsets: ${totals.totalPsalmOffsets}. ` +
      `Psalm verses inserted: ${totals.totalPsalmInserted}. ` +
      `Appended extras: ${totals.totalAppendedExtras}. ` +
      `Missing from Bible: ${totals.totalMissing}.`,
  )

  return {
    replacedVerses: totals.totalReplaced,
    missingFromBible: totals.totalMissing,
    extraInBibleAppended: totals.totalAppendedExtras,
    psalmSubheaderOffsets: totals.totalPsalmOffsets,
    psalmVersesInserted: totals.totalPsalmInserted,
    modifiedStories: totals.modifiedStories,
  }
}

/**
 * Replace the verse content of every `Stories/*.xml` in an already-exported
 * Study Bible IDML with the matching verses from a translated Bible IDML.
 * Returns the rewritten IDML bytes plus a report for the caller to surface.
 */
export async function applyBibleSwapToIdml(
  studyIdmlData: Uint8Array,
  bibleIdmlData: Uint8Array,
  options: BibleSwapPassOptions = {},
): Promise<{ idml: Uint8Array; report: BibleSwapReport }> {
  if (!isZipArchive(bibleIdmlData)) {
    throw new Error("Bible Swap: provided Bible IDML data is not a valid IDML/ZIP archive.")
  }
  if (!isZipArchive(studyIdmlData)) {
    throw new Error("Bible Swap: exported Study IDML data is not a valid IDML/ZIP archive.")
  }

  const studyZip = await JSZip.loadAsync(toTightZipBytes(studyIdmlData))
  const bibleZip = await JSZip.loadAsync(toTightZipBytes(bibleIdmlData))
  const bibleStoryXml = await largestBibleStoryXml(bibleZip)

  const { swapMode = "surgical", serializedPlan, language, studyVolume } = options
  console.log(
    `[Bible Swap] Using ${swapMode} mode with Bible story (${bibleStoryXml.length} chars)` +
      (serializedPlan ? " with precomputed language mapping plan" : "") +
      (language && language !== "any"
        ? ` [language=${language}${studyVolume ? `/${studyVolume}` : ""}]`
        : ""),
  )

  const report = await spliceBibleSwapIntoZip(studyZip, bibleStoryXml, options)

  const idml = await studyZip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  })
  return { idml, report }
}
