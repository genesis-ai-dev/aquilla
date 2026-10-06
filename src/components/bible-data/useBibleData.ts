// Bible data in the editor (AQU-1689): the one hook EditorTable calls.
//
// It composes Voices (AQU-1687) and Who's Who over one read of the file's
// cells, and owns the Bible data cell filter, which has two kinds:
//   • speaker  — "Show every line by …", from a voice chip (AQU-1687);
//   • mentions — "Show cells that mention …", from a mention popover or the
//                Who's Who panel.
// One filter at a time; picking either replaces the other. The filter belongs
// to one file, and leaving the file drops it. The Who's Who panel sets it
// through the Bible data bus and reads it back from there.

import { useCallback, useEffect, useMemo, useState } from "react"
import type { CellStore, CellSummary } from "@/hooks/useActiveCellStore"
import type { BkpEntityId, BkpRef } from "@/lib/bible-data/pack-types"
import type { VoiceCastCell } from "@/lib/bible-data/voice-cast"
import { isBibleDataExperimentOn } from "@/lib/bible-data/experiment"
import { mentionsEntity, type PeopleIndex } from "@/lib/bible-data/people-index"
import {
  cellVerses,
  cellVoicesFor,
  sharedVerseRefs,
  speaksIn,
  type VoiceCellInput,
  type VoiceIndex,
} from "@/lib/bible-data/voice-index"
import { projectHasScriptureFiles, type ProjectRecord } from "@/lib/parsers/types"
import { ownCastName } from "@/lib/timeline/cue-character"
import { useBibleDataViewPrefs } from "@/lib/store/bible-data-view-prefs"
import { resolveBibleEnrichment } from "../../../db/shared/bible-enrichments"
import {
  onBibleFilterRequest,
  publishBibleFilter,
  publishBiblePackStatus,
  type BibleFilterKind,
  type BibleFilterSpec,
} from "./bible-data-bus"
import type { TargetCorpusCell } from "./target-bridge"
import { useBibleVoices } from "./useBibleVoices"
import { useWhosWho } from "./useWhosWho"
import { useVerseCells } from "./verse-cells"
import type { BibleVoicesContextValue, VoiceMaintainerActions } from "./voices-context"
import type { WhosWhoContextValue } from "./whos-who-context"

export interface BibleDataOptions {
  project: ProjectRecord
  /** A Bible is open (EditorTable's `bibleOpen`); false shows nothing and fetches nothing. */
  bibleOpen: boolean
  cellStore: CellStore
  /** The file's cells, in document order. */
  cellIds: readonly string[]
  /** The cell store version, so refs are re-read when cells change. */
  version: number
  fileId: string | null
  /** Scroll the editor to a cell (a mention jump). */
  jumpToCell: (cellId: string) => void
  /** Sync tokens, for the stored word alignment (AQU-1694). */
  getTokenForFile?: (fileId: string) => Promise<string | null>
  /** AQU-1692: the person may correct voices (a maintainer, with somewhere to save). */
  canCorrectVoices?: boolean
  /** AQU-1692: the person may adopt the voices as the cast (a maintainer, with somewhere to send it). */
  canAdoptVoiceCast?: boolean
}

/** The filter as the bar above the list shows it. */
export interface BibleFilterView {
  kind: BibleFilterKind
  entity: BkpEntityId
  /** The participant's name through the label chain; null when the pack has none. */
  name: string | null
  count: number
}

export interface BibleData {
  /** What rows read through BibleVoicesContext; null while Voices shows nothing. */
  voices: BibleVoicesContextValue | null
  /** What rows read through WhosWhoContext; null while Who's Who and the Context tab show nothing. */
  whosWho: WhosWhoContextValue | null
  /** The file's cells the filter keeps, in order; null with no filter. */
  filteredCellIds: readonly string[] | null
  filter: BibleFilterView | null
  /** True when the filter is hiding this cell of the file. */
  filterHides: (cellId: string) => boolean
  clearFilter: () => void
  /** AQU-1692: the speech a maintainer is correcting, or null. */
  correcting: string | null
  closeCorrection: () => void
  /** AQU-1692: the chapter whose voices a maintainer is adopting as the cast, or null. */
  adoptingCast: string | null
  closeAdoptCast: () => void
  /** AQU-1692: the file's cells as adopting reads them, with the cast names they have now. */
  voiceCastCells: () => VoiceCastCell[]
}

const NO_CORRECTIONS: readonly string[] = []

/** The cells a filter keeps, or null when it cannot apply (its data is not loaded). */
export function filterCells(
  spec: BibleFilterSpec,
  cells: readonly VoiceCellInput[],
  cellIds: readonly string[],
  shared: ReadonlySet<BkpRef>,
  voiceIndex: VoiceIndex | null,
  peopleIndex: PeopleIndex | null,
): string[] | null {
  if (cells.length !== cellIds.length) return null
  if (spec.kind === "speaker") {
    if (!voiceIndex) return null
    return cellIds.filter((_, position) => {
      const voices = cellVoicesFor(voiceIndex, cells[position], shared)
      return voices !== null && speaksIn(voices, spec.entity)
    })
  }
  if (!peopleIndex) return null
  return cellIds.filter((_, position) => {
    const verses = cellVerses(cells[position])
    return verses !== null && verses.book === peopleIndex.book && mentionsEntity(peopleIndex, verses.refs, spec.entity)
  })
}

/** The file's verse cells as Bridge 2 reads them: both texts, and the chapter ("JHN 4"). */
export function targetCorpusOf(summaries: readonly CellSummary[]): TargetCorpusCell[] {
  return summaries.flatMap((cell) => {
    const verses = cellVerses({ ref: cell.group, type: cell.type })
    if (!verses) return []
    const first = verses.refs[0]
    return [{ cellId: cell.id, chapter: first.slice(0, first.lastIndexOf(":")), source: cell.original, target: cell.translated }]
  })
}

export function useBibleData({
  project,
  bibleOpen,
  cellStore,
  cellIds,
  version,
  fileId,
  jumpToCell,
  getTokenForFile,
  canCorrectVoices = false,
  canAdoptVoiceCast = false,
}: BibleDataOptions): BibleData {
  const prefs = useBibleDataViewPrefs()
  const hasScripture = projectHasScriptureFiles(project.files)
  // AQU-1685: only on a device with the Bible data experiment on, and only
  // while a Bible is open. loadLayer does not check the experiment itself.
  const shown = bibleOpen && isBibleDataExperimentOn(project)
  const voicesWanted =
    shown && resolveBibleEnrichment(project, "voices", hasScripture) && (prefs.voiceChips || prefs.speechRails)
  const whosWhoOn = shown && resolveBibleEnrichment(project, "whos-who", hasScripture)
  const contextOn = shown && resolveBibleEnrichment(project, "original-context", hasScripture)
  // AQU-1695: what the Context tab adds. Their layers load when it first opens.
  const helpsOn = shown && resolveBibleEnrichment(project, "helps", hasScripture)
  const termsOn = shown && resolveBibleEnrichment(project, "terms", hasScripture)

  const cells = useVerseCells(cellStore, cellIds, version, voicesWanted || whosWhoOn || contextOn)
  const shared = useMemo(() => sharedVerseRefs(cells), [cells])

  // The filter belongs to one file. Leaving the file drops it (React's
  // "adjust state when a prop changes" pattern, so no effect is needed).
  const [state, setState] = useState<{ fileId: string; spec: BibleFilterSpec } | null>(null)
  if (state && state.fileId !== fileId) setState(null)
  const spec = state && state.fileId === fileId ? state.spec : null
  const setFilter = useCallback(
    (next: BibleFilterSpec | null) => setState(next && fileId ? { fileId, spec: next } : null),
    [fileId],
  )
  const clearFilter = useCallback(() => setState(null), [])
  const showLinesBy = useCallback((entity: BkpEntityId) => setFilter({ kind: "speaker", entity }), [setFilter])
  const showMentionsOf = useCallback((entity: BkpEntityId) => setFilter({ kind: "mentions", entity }), [setFilter])

  // AQU-1692: a maintainer's dialogs: correcting a speech, and adopting a
  // chapter's voices as the cast. Each belongs to one file, like the filter.
  const [dialog, setDialog] = useState<{ fileId: string; correct?: string; adoptCast?: string } | null>(null)
  if (dialog && dialog.fileId !== fileId) setDialog(null)
  const open = dialog && dialog.fileId === fileId ? dialog : null
  const closeDialog = useCallback(() => setDialog(null), [])
  const maintainer = useMemo<VoiceMaintainerActions | null>(() => {
    if (!fileId || (!canCorrectVoices && !canAdoptVoiceCast)) return null
    return {
      correct: canCorrectVoices ? (speechId: string) => setDialog({ fileId, correct: speechId }) : null,
      adoptCast: canAdoptVoiceCast ? (chapter: string) => setDialog({ fileId, adoptCast: chapter }) : null,
    }
  }, [canCorrectVoices, canAdoptVoiceCast, fileId])
  const voiceCastCells = useCallback(
    (): VoiceCastCell[] =>
      cellIds.map((cellId, position) => {
        const view = cellStore.getCellView(cellId)
        return { ...cells[position], cellId, castName: view ? ownCastName(view) : null }
      }),
    [cellIds, cells, cellStore],
  )

  const { context: voices, failure: voicesFailure } = useBibleVoices({
    project,
    cells,
    shared,
    enabled: voicesWanted,
    showLinesBy,
    maintainer,
  })
  // AQU-1694: Bridge 2 trains on the file's cells as they are when it runs.
  const targetCorpus = useCallback(() => targetCorpusOf(cellStore.getAllSummaries()), [cellStore])
  const whosWho = useWhosWho({
    project,
    cells,
    cellIds,
    shared,
    fileId,
    whosWhoOn,
    contextOn,
    helpsOn,
    termsOn,
    jumpToCell,
    showMentionsOf,
    getTokenForFile,
    targetCorpus,
  })

  // A "mentions" filter needs Who's Who on; a speaker filter needs Voices.
  const voiceIndex = voices?.index ?? null
  const peopleIndex = whosWhoOn ? whosWho.index : null
  const filteredCellIds = useMemo(
    () => (spec ? filterCells(spec, cells, cellIds, shared, voiceIndex, peopleIndex) : null),
    [spec, cells, cellIds, shared, voiceIndex, peopleIndex],
  )
  const applied = filteredCellIds ? spec : null

  // AQU-1692: View settings → Bible data says how the open book's data loaded,
  // and lists this book's corrections whose speech a rebuilt pack no longer has.
  const failure = voicesFailure ?? whosWho.failure
  const statusBook = voices?.index.book ?? failure?.book ?? null
  const failureReason = failure?.reason ?? null
  const orphanedCorrections = voices?.index.orphanedOverrides ?? NO_CORRECTIONS
  useEffect(() => {
    if (!fileId || !statusBook) return
    publishBiblePackStatus(fileId, { book: statusBook, failure: failureReason, orphanedCorrections })
    return () => publishBiblePackStatus(fileId, null)
  }, [fileId, statusBook, failureReason, orphanedCorrections])

  // The Who's Who panel sets the filter for this file, and shows which one applies.
  useEffect(() => {
    if (!fileId) return
    return onBibleFilterRequest(fileId, setFilter)
  }, [fileId, setFilter])
  useEffect(() => {
    if (!fileId) return
    publishBibleFilter(fileId, applied)
    return () => publishBibleFilter(fileId, null)
  }, [fileId, applied])

  const filteredSet = useMemo(() => (filteredCellIds ? new Set(filteredCellIds) : null), [filteredCellIds])
  const filterHides = useCallback(
    (cellId: string) => filteredSet !== null && !filteredSet.has(cellId) && cellIds.includes(cellId),
    [filteredSet, cellIds],
  )

  const voiceLabelFor = voices?.labelFor ?? null
  const nameOf = whosWho.nameOf
  const filter = useMemo<BibleFilterView | null>(() => {
    if (!applied || !filteredCellIds) return null
    const name =
      applied.kind === "speaker" ? (voiceLabelFor?.(applied.entity)?.label ?? null) : (nameOf?.(applied.entity) ?? null)
    return { kind: applied.kind, entity: applied.entity, name, count: filteredCellIds.length }
  }, [applied, filteredCellIds, voiceLabelFor, nameOf])

  return {
    voices,
    whosWho: whosWho.context,
    filteredCellIds,
    filter,
    filterHides,
    clearFilter,
    correcting: voices ? (open?.correct ?? null) : null,
    closeCorrection: closeDialog,
    adoptingCast: voices ? (open?.adoptCast ?? null) : null,
    closeAdoptCast: closeDialog,
    voiceCastCells,
  }
}
