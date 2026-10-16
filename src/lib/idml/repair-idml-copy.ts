import type { IdmlFormatMetadataV2 } from "@aquilla/idml-roundtrip"
import { matchImportContent, orderSourceCellsByAnchor } from "../../../sync-worker/src/events/import-content-match"
import { extractIdmlStrings } from "@/lib/parsers/idml"
import type { TranslatableString } from "@/lib/parsers/core-types"
import { t } from "@/lib/i18n/standalone"
import { emitParsedFile, type ImportResult } from "@/lib/import"
import { normalizeTranslatableStrings } from "@/lib/import/normalized-manifest"
import type { FileReference } from "@/lib/parsers/types"
import { partnerIntegrations } from "@/lib/partners/registry"
import { fetchRawOriginalSource } from "@/lib/sync/source-export"
import { fetchFileCells } from "@/lib/sync/cells-read"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { stitchIdmlSlotTexts } from "./completion"
import { idmlPlainMatchesTranslation } from "./protected-html"
import {
  distributeTranslationLikeSource,
  targetDistributionCollapsesSource,
} from "./segment-distribution"
import {
  alignReimportedIdmlFile,
  type IdmlReimportAlignHost,
} from "./align-reimported-targets"

const GENERIC_IDML_PROFILE = "builtin:idml-roundtrip"
const GENERIC_IDML_PROFILE_VERSION = "2"

/**
 * Codex cells and the IDML parser disagree about which apostrophe a heading
 * uses (U+02BC versus ASCII). Folding them only for the match keeps the
 * parser's own character in the repaired source.
 */
const APOSTROPHE_FOLD = /[\u2018\u2019\u201B\u02BC\u2032']/g

export interface IdmlRepairSourceCell {
  readonly cellId: string
  readonly anchorCellId?: string | null
  readonly value: string
  readonly translated: string
  readonly translatedHtml?: string | null
}

export interface IdmlRepairTranslationPlan {
  readonly strings: TranslatableString[]
  /** Translations copied onto a parsed unit whose source text matched. */
  readonly copied: number
  /** Existing translations whose source text did not match a parsed unit. */
  readonly unmatched: number
}

/**
 * Copy each existing translation onto the parsed unit with the same source
 * text, using neighbor context when a line is repeated. The copy is plain
 * text: the parser's empty protected HTML would otherwise look already aligned
 * and Align styles would leave the words out of the runs.
 */
export function applyIdmlRepairTranslations(
  strings: readonly TranslatableString[],
  existing: readonly IdmlRepairSourceCell[],
): IdmlRepairTranslationPlan {
  const ordered = orderSourceCellsByAnchor(existing)
  const incoming = strings.map((string, index) => ({
    cellId: String(index),
    value: repairMatchValue(string.original),
  }))
  const { adopted } = matchImportContent(
    incoming,
    ordered.map((cell) => ({ cellId: cell.cellId, value: repairMatchValue(cell.value) })),
    new Map(),
  )
  const byId = new Map(ordered.map((cell) => [cell.cellId, cell]))
  const used = new Set<string>()
  let copied = 0
  const next = strings.map((string, index) => {
    const match = adopted.get(String(index))
    const source = match ? byId.get(match.cellId) : undefined
    const plain = source ? repairPlainText(source) : ""
    if (!source || !plain) return string
    used.add(source.cellId)
    copied += 1
    // The old cell already split the translation across character styles.
    // Keeping that split is what makes bold and italic survive; dropping it
    // leaves plain text, which export refuses because the slot shell is gone.
    const placed = protectedTargetFromLegacySegments(string, source.translatedHtml, plain)
    if (placed) return { ...string, translated: placed.translated, translatedHtml: placed.translatedHtml }
    const { translatedHtml: _protectedEmpty, ...rest } = string
    return { ...rest, translated: plain }
  })
  const unmatched = ordered.filter((cell) => repairPlainText(cell) && !used.has(cell.cellId)).length
  return { strings: next, copied, unmatched }
}

/** "{name} (repaired)", then "(repaired 2)", so a second repair does not collide. */
export function repairedCopyName(name: string, existingNames: readonly string[]): string {
  const base = name.replace(/\s+\(repaired(?: \d+)?\)$/i, "").trim() || name.trim()
  const taken = new Set(existingNames.map((entry) => entry.trim().toLowerCase()))
  const first = `${base} (repaired)`
  if (!taken.has(first.toLowerCase())) return first
  let suffix = 2
  while (taken.has(`${base} (repaired ${suffix})`.toLowerCase())) suffix += 1
  return `${base} (repaired ${suffix})`
}

export interface IdmlRepairParseCandidate {
  readonly id: string
  readonly strings: readonly TranslatableString[]
  readonly profileId: string
  readonly profileVersion: string
  readonly corpusMarker?: string
  readonly bookCode?: string
}

/**
 * Keep the read whose cells line up with the file. A plain IDML parse of a
 * study-notes package merges note paragraphs the notes importer keeps apart,
 * so the copy would be longer cells with nowhere for the translations to land.
 * The plain parse stays when a partner read fits the file worse. A partner
 * read wins by placing more of the existing lines, by matching the same lines
 * with a closer cell count, or by matching every line when the plain parse
 * does too — that last case is the same segmentation, stamped as the import
 * that produced it. A later edition does not replace an earlier perfect match.
 */
export function chooseIdmlRepairParse(
  existing: readonly { cellId: string; anchorCellId?: string | null; value: string }[],
  candidates: readonly IdmlRepairParseCandidate[],
): IdmlRepairParseCandidate {
  const first = candidates[0]
  if (!first) throw new Error(t("importExport.dialog.repairIdmlCopyNeedsOriginal"))
  const ordered = orderSourceCellsByAnchor(existing)
  const existingCells = ordered.map((cell) => ({
    cellId: cell.cellId,
    value: repairMatchValue(cell.value),
  }))
  let best = first
  let bestScore = repairParseScore(first, existingCells, ordered.length)
  for (const candidate of candidates.slice(1)) {
    const score = repairParseScore(candidate, existingCells, ordered.length)
    const morePlaced = score.placed > bestScore.placed
    const closerCount = score.placed === bestScore.placed && score.distance < bestScore.distance
    const samePerfectMatch = best.id === "generic"
      && perfectRepairScore(score, ordered.length)
      && perfectRepairScore(bestScore, ordered.length)
    if (morePlaced || closerCount || samePerfectMatch) {
      best = candidate
      bestScore = score
    }
  }
  return best
}

export async function repairIdmlFileAsCopy(args: {
  projectId: string
  fileId: string
  fileName: string
  existingNames?: readonly string[]
  lane?: string
  author: string
  sourceLanguage?: string
  targetLanguage?: string
  getToken: (fileId: string) => Promise<string | null>
  align?: IdmlReimportAlignHost
  signal?: AbortSignal
  onProgress?: (label: string) => void
}): Promise<{ ref: FileReference; copied: number; unmatched: number }> {
  args.onProgress?.(t("importExport.dialog.repairingIdmlCopy", { fileName: args.fileName }))
  const original = await fetchRawOriginalSource({
    projectId: args.projectId,
    fileId: args.fileId,
    getToken: args.getToken,
    targetLang: args.lane,
  })
  // IDML sidecars come back as the stored package (`raw-sidecar`), which is the
  // byte-exact upload. A USFM response is not an IDML package and will fail
  // the parse below.
  const jwt = await args.getToken(args.fileId)
  if (!jwt) throw new Error(t("importExport.dialog.repairIdmlCopyNeedsOriginal"))
  const rows = await loadRows(args.projectId, args.fileId, args.lane ?? "", jwt, args.signal)
  const sources = repairSources(rows, args.lane ?? "")
  const chosen = chooseIdmlRepairParse(sources, await repairParseCandidates(original.bytes, args.signal))
  const plan = applyIdmlRepairTranslations(chosen.strings, sources)
  const copyName = repairedCopyName(args.fileName, args.existingNames ?? [])
  const strings = plan.strings
  const result: ImportResult = {
    name: copyName,
    strings,
    rawBytes: original.bytes.slice(0),
    rawSourceFormat: "idml",
    roundTripFidelity: "content-only",
    ...(chosen.corpusMarker ? { corpusMarker: chosen.corpusMarker } : {}),
    ...(chosen.bookCode ? { bookCode: chosen.bookCode } : {}),
  }
  const normalized = normalizeTranslatableStrings(strings, {
    fileName: copyName,
    fileType: "idml",
    profileId: chosen.profileId,
    profileVersion: chosen.profileVersion,
    fidelity: "content-only",
  })
  const emitted = await emitParsedFile(result, "idml", {
    projectId: args.projectId,
    author: args.author,
    sourceLanguage: args.sourceLanguage,
    targetLanguage: args.targetLanguage,
    targetLang: args.lane,
    getToken: args.getToken,
    signal: args.signal,
    onPhase: args.onProgress,
  }, normalized)
  if (args.align && emitted.ref.id !== args.fileId) {
    await alignReimportedIdmlFile({
      projectId: args.projectId,
      fileId: emitted.ref.id,
      lane: args.lane,
      getToken: args.getToken,
      host: args.align,
      sourceLanguage: args.sourceLanguage ?? "",
      targetLanguage: args.targetLanguage ?? "",
      signal: args.signal,
      onProgress: (done, total) => {
        args.onProgress?.(t("importExport.upload.aligningIdmlStyles", {
          fileName: copyName,
          count: done.toLocaleString(),
          total: total.toLocaleString(),
        }))
      },
    })
  }
  return { ref: emitted.ref, copied: plan.copied, unmatched: plan.unmatched }
}

const APOSTROPHE_ONLY = /^['\u2018\u2019\u201B\u02BC\u2032\u00B4]+$/

/**
 * Place a Codex cell's `idml-segment` runs into the new protected slots.
 *
 * The old target already recorded which words are bold or italic. The new
 * parse adds extra slots for English apostrophe glue (`source serif`), so the
 * old runs are a subsequence of the new slots rather than a 1:1 list. Slots
 * the old cell never had stay empty; the glue is not part of the translation.
 * Returns nothing when the old HTML has no segments or its styles are not
 * that subsequence — the caller then leaves plain text for Align styles.
 */
function protectedTargetFromLegacySegments(
  string: TranslatableString,
  legacyHtml: string | null | undefined,
  expectedTranslation: string,
): { translated: string; translatedHtml: string } | undefined {
  if (!legacyHtml?.includes("idml-segment") || !string.originalHtml || typeof document === "undefined") {
    return undefined
  }
  const metadata = idmlMetadataOf(string.metadata)
  if (!metadata) return undefined
  const slots = readEditableSlots(string.originalHtml, metadata)
  let texts = legacySegmentSlotTexts(string.originalHtml, metadata, legacyHtml)
  if (!texts) return undefined
  if (targetDistributionCollapsesSource(slots, texts)) {
    const fixed = distributeTranslationLikeSource(slots, expectedTranslation)
    if (!fixed) return undefined
    texts = fixed
  }
  try {
    const completion = stitchIdmlSlotTexts(
      { id: string.id, originalHtml: string.originalHtml, metadata: string.metadata ?? null },
      texts,
      { preserveWording: expectedTranslation },
    )
    if (!completion.valueHtml) return undefined
    if (!idmlPlainMatchesTranslation(completion.value, expectedTranslation)) return undefined
    return { translated: expectedTranslation, translatedHtml: completion.valueHtml }
  } catch {
    return undefined
  }
}

function legacySegmentSlotTexts(
  sourceHtml: string,
  metadata: IdmlFormatMetadataV2,
  legacyHtml: string,
): Map<number, string> | undefined {
  const segments = readLegacySegments(legacyHtml)
  if (segments.length === 0) return undefined
  const slots = readEditableSlots(sourceHtml, metadata)
  if (slots.length !== metadata.editableSlotIndexes.length) return undefined
  let next = 0
  const texts = new Map<number, string>()
  for (const slot of slots) {
    if (isApostropheGlue(slot.style, slot.text)) {
      texts.set(slot.index, "")
      continue
    }
    const segment = segments[next]
    if (!segment || styleKey(segment.style) !== styleKey(slot.style)) {
      texts.set(slot.index, "")
      continue
    }
    texts.set(slot.index, segment.text)
    next += 1
  }
  return next === segments.length ? texts : undefined
}

function readLegacySegments(html: string): { style: string; text: string }[] {
  const root = document.createElement("div")
  root.innerHTML = html
  return [...root.querySelectorAll("span.idml-segment")].map((span) => ({
    style: span.getAttribute("data-character-style") ?? "",
    text: span.textContent ?? "",
  }))
}

function readEditableSlots(
  sourceHtml: string,
  metadata: IdmlFormatMetadataV2,
): { index: number; style: string; text: string }[] {
  const root = document.createElement("div")
  root.innerHTML = sourceHtml
  const slots = []
  for (const index of metadata.editableSlotIndexes) {
    const span = root.querySelector(`span[data-idml-slot="${index}"]`)
    if (!span) return []
    slots.push({
      index,
      style: span.getAttribute("data-idml-character-style") ?? "",
      text: span.textContent ?? "",
    })
  }
  return slots
}

function isApostropheGlue(style: string, text: string): boolean {
  return /source serif/i.test(style) || APOSTROPHE_ONLY.test(text.trim())
}

function styleKey(style: string): string {
  const decoded = style.includes("%") ? safeDecode(style) : style
  return decoded.replace(/\s+/g, " ").trim()
}

function safeDecode(style: string): string {
  try {
    return decodeURIComponent(style)
  } catch {
    return style
  }
}

function idmlMetadataOf(metadata: TranslatableString["metadata"]): IdmlFormatMetadataV2 | undefined {
  const candidate = metadata?.idml
  if (
    typeof candidate !== "object"
    || candidate === null
    || Array.isArray(candidate)
    || (candidate as { version?: unknown }).version !== 2
  ) {
    return undefined
  }
  const indexes = (candidate as { editableSlotIndexes?: unknown }).editableSlotIndexes
  if (!Array.isArray(indexes) || !indexes.every((index) => Number.isInteger(index))) return undefined
  return candidate as IdmlFormatMetadataV2
}

function repairMatchValue(value: string): string {
  return value.replace(APOSTROPHE_FOLD, "'")
}

function perfectRepairScore(score: { placed: number; distance: number }, existingCount: number): boolean {
  return existingCount > 0 && score.placed === existingCount && score.distance === 0
}

function repairParseScore(
  candidate: IdmlRepairParseCandidate,
  existing: readonly { cellId: string; value: string }[],
  existingCount: number,
): { placed: number; distance: number } {
  const incoming = candidate.strings.map((string, index) => ({
    cellId: String(index),
    value: repairMatchValue(string.original),
  }))
  const { adopted } = matchImportContent(incoming, existing, new Map())
  return { placed: adopted.size, distance: Math.abs(candidate.strings.length - existingCount) }
}

async function repairParseCandidates(
  bytes: ArrayBuffer,
  signal?: AbortSignal,
): Promise<IdmlRepairParseCandidate[]> {
  const candidates: IdmlRepairParseCandidate[] = []
  try {
    candidates.push({
      id: "generic",
      strings: await extractIdmlStrings(bytes.slice(0)),
      profileId: GENERIC_IDML_PROFILE,
      profileVersion: GENERIC_IDML_PROFILE_VERSION,
    })
  } catch {
    // A partner read of the same bytes can still be the package. The throw
    // below covers the case where every read failed.
  }
  for (const integration of partnerIntegrations()) {
    const editions = await integration.idmlImportEditions?.() ?? []
    for (const edition of editions) {
      if (signal?.aborted) break
      try {
        const parsed = await edition.parse(bytes.slice(0), {
          onProgress: () => undefined,
          ...(signal ? { signal } : {}),
        })
        if (parsed.strings.length === 0) continue
        candidates.push({
          id: edition.id,
          strings: parsed.strings,
          profileId: edition.profileId,
          profileVersion: "1",
          corpusMarker: edition.corpusMarker,
          ...(parsed.bookCodes.length === 1 ? { bookCode: parsed.bookCodes[0] } : {}),
        })
      } catch {
        // The wrong template for this package. Another edition may still fit.
      }
    }
  }
  if (candidates.length === 0) {
    throw new Error(t("importExport.dialog.repairIdmlCopyNeedsOriginal"))
  }
  return candidates
}

function repairPlainText(cell: Pick<IdmlRepairSourceCell, "translated" | "translatedHtml">): string {
  const plain = cell.translated.trim()
  if (plain) return cell.translated
  if (!cell.translatedHtml?.trim()) return ""
  return cell.translatedHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
}

function repairSources(rows: readonly CellRow[], lane: string): IdmlRepairSourceCell[] {
  const wanted = lane || ""
  const sources = new Map<string, CellRow>()
  const targets = new Map<string, CellRow>()
  for (const row of rows) {
    if (row.side === "source") sources.set(row.cellId, row)
    else if ((row.targetLang ?? "") === wanted) targets.set(row.cellId, row)
  }
  return [...sources.values()].map((source) => {
    const target = targets.get(source.cellId)
    return {
      cellId: source.cellId,
      anchorCellId: source.anchorCellId,
      value: source.value,
      translated: target?.value ?? "",
      translatedHtml: target?.valueHtml ?? null,
    }
  })
}

async function loadRows(
  projectId: string,
  fileId: string,
  lane: string,
  jwt: string,
  signal?: AbortSignal,
): Promise<CellRow[]> {
  const rows: CellRow[] = []
  let cursor: string | undefined
  for (;;) {
    if (signal?.aborted) return rows
    const page = await fetchFileCells(projectId, fileId, {
      paired: true,
      limit: 2000,
      ...(lane ? { lane } : {}),
      ...(cursor ? { cursor } : {}),
    }, jwt)
    rows.push(...page.cells)
    if (!page.nextCursor) return rows
    cursor = page.nextCursor
  }
}
