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
import type { CellStore } from "@/hooks/useActiveCellStore"
import type { BkpEntityId, BkpRef } from "@/lib/bible-data/pack-types"
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
import { useBibleDataViewPrefs } from "@/lib/store/bible-data-view-prefs"
import { resolveBibleEnrichment } from "../../../db/shared/bible-enrichments"
import { onBibleFilterRequest, publishBibleFilter, type BibleFilterKind, type BibleFilterSpec } from "./bible-data-bus"
import { useBibleVoices } from "./useBibleVoices"
import { useWhosWho } from "./useWhosWho"
import { useVerseCells } from "./verse-cells"
import type { BibleVoicesContextValue } from "./voices-context"
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
}

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

export function useBibleData({ project, bibleOpen, cellStore, cellIds, version, fileId, jumpToCell }: BibleDataOptions): BibleData {
  const prefs = useBibleDataViewPrefs()
  const hasScripture = projectHasScriptureFiles(project.files)
  // AQU-1685: only on a device with the Bible data experiment on, and only
  // while a Bible is open. loadLayer does not check the experiment itself.
  const shown = bibleOpen && isBibleDataExperimentOn(project)
  const voicesWanted =
    shown && resolveBibleEnrichment(project, "voices", hasScripture) && (prefs.voiceChips || prefs.speechRails)
  const whosWhoOn = resolveBibleEnrichment(project, "whos-who", hasScripture)
  const contextOn = resolveBibleEnrichment(project, "original-context", hasScripture)

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

  const voices = useBibleVoices({ project, cells, shared, enabled: voicesWanted, showLinesBy })
  const whosWho = useWhosWho({
    project,
    cells,
    cellIds,
    shared,
    fileId,
    whosWhoOn,
    contextOn,
    jumpToCell,
    showMentionsOf,
  })

  // A "mentions" filter needs Who's Who on; a speaker filter needs Voices.
  const voiceIndex = voices?.index ?? null
  const peopleIndex = whosWhoOn ? whosWho.index : null
  const filteredCellIds = useMemo(
    () => (spec ? filterCells(spec, cells, cellIds, shared, voiceIndex, peopleIndex) : null),
    [spec, cells, cellIds, shared, voiceIndex, peopleIndex],
  )
  const applied = filteredCellIds ? spec : null

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

  return { voices, whosWho: whosWho.context, filteredCellIds, filter, filterHides, clearFilter }
}
