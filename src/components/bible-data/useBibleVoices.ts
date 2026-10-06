// Voices in the editor (AQU-1687): the table-level half.
//
// EditorTable calls this once per render. It:
//   • loads the pack's `voices` and `people` layers for the open book, only
//     while the project's Voices enrichment is on and the person shows chips
//     or rails (View settings → Bible data);
//   • builds the index once per (pack version, book);
//   • resolves names through the label chain (project names → interface
//     language → English, as the person chose);
//   • owns the "Show every line by …" filter, which EditorTable applies to the
//     rows it lists.
// Rows read the result through BibleVoicesContext. Nothing here throws: an
// unavailable pack means no chips and no rails.

import { useCallback, useEffect, useMemo, useState } from "react"
import { readAtVersion, type CellStore } from "@/hooks/useActiveCellStore"
import { projectTargetLaneLanguages } from "@/lib/audio/inworld-voices"
import { loadLayer, loadManifest, type BkpFailureReason } from "@/lib/bible-data/pack-client"
import type { BkpEntityId, BkpPeopleLayer, BkpVoicesLayer } from "@/lib/bible-data/pack-types"
import { mapLayerToProject } from "@/lib/bible-data/versification"
import {
  cellVoicesFor,
  firstVerseBook,
  sharedVerseRefs,
  speaksIn,
  voiceIndexFor,
  type VoiceCellInput,
} from "@/lib/bible-data/voice-index"
import {
  acaiLanguageFor,
  acaiLanguageForLocale,
  resolveVoiceLabel,
  type VoiceLabel,
  type VoiceLabelOptions,
} from "@/lib/bible-data/voice-labels"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { projectHasScriptureFiles, type ProjectRecord } from "@/lib/parsers/types"
import { useBibleDataViewPrefs } from "@/lib/store/bible-data-view-prefs"
import { resolveBibleEnrichment } from "../../../db/shared/bible-enrichments"
import type { BibleVoicesContextValue } from "./voices-context"

export type VoicesPack =
  | { ok: true; book: string; version: string; voices: BkpVoicesLayer; people: BkpPeopleLayer }
  | { ok: false; book: string; reason: BkpFailureReason }

/** One book's voices and people layers, in the project's versification. Never throws. */
export async function loadVoicesPack(book: string): Promise<VoicesPack> {
  try {
    const [manifest, voices, people] = await Promise.all([
      loadManifest(),
      loadLayer("voices", book),
      loadLayer("people", book),
    ])
    if (!manifest.ok) return { ok: false, book, reason: manifest.reason }
    if (!voices.ok) return { ok: false, book, reason: voices.reason }
    if (!people.ok) return { ok: false, book, reason: people.reason }
    return {
      ok: true,
      book,
      version: manifest.value.version,
      voices: mapLayerToProject(voices.value),
      people: mapLayerToProject(people.value),
    }
  } catch {
    return { ok: false, book, reason: "offline" }
  }
}

function useVoicesPack(book: string | null): VoicesPack | null {
  const [pack, setPack] = useState<VoicesPack | null>(null)
  useEffect(() => {
    if (!book) return
    let live = true
    void loadVoicesPack(book).then((next) => {
      if (live) setPack(next)
    })
    return () => {
      live = false
    }
  }, [book])
  return book && pack?.book === book ? pack : null
}

export interface BibleVoicesOptions {
  project: ProjectRecord
  cellStore: CellStore
  /** The file's cells, in document order. */
  cellIds: readonly string[]
  /** The cell store version, so refs are re-read when cells change. */
  version: number
  fileId: string | null
}

export interface BibleVoicesFilter {
  speaker: BkpEntityId
  /** The speaker's name through the label chain; null when the pack has none. */
  label: VoiceLabel | null
  count: number
}

export interface BibleVoices {
  /** What rows read through BibleVoicesContext; null while Voices shows nothing. */
  context: BibleVoicesContextValue | null
  /** The file's cells the "Show every line by …" filter keeps, in order; null with no filter. */
  filteredCellIds: readonly string[] | null
  filter: BibleVoicesFilter | null
  /** True when the filter is hiding this cell of the file. */
  filterHides: (cellId: string) => boolean
  clearFilter: () => void
}

export function useBibleVoices({ project, cellStore, cellIds, version, fileId }: BibleVoicesOptions): BibleVoices {
  const prefs = useBibleDataViewPrefs()
  const { locale } = useI18n()
  const voicesOn = resolveBibleEnrichment(project, "voices", projectHasScriptureFiles(project.files))
  const wanted = voicesOn && (prefs.voiceChips || prefs.speechRails)

  // One "type<TAB>ref" line per cell. A string, so everything below survives
  // keystrokes, which bump `version` without changing any ref.
  const cellsKey = useMemo(
    () =>
      wanted
        ? readAtVersion(version, () =>
            cellIds
              .map((id) => {
                const view = cellStore.getCellView(id)
                return view ? `${view.type}\t${view.group}` : "\t"
              })
              .join("\n"),
          )
        : "",
    [wanted, version, cellIds, cellStore],
  )
  const cells = useMemo<VoiceCellInput[]>(
    () =>
      cellsKey === ""
        ? []
        : cellsKey.split("\n").map((line) => {
            const tab = line.indexOf("\t")
            return { type: line.slice(0, tab), ref: line.slice(tab + 1) }
          }),
    [cellsKey],
  )
  const book = useMemo(() => firstVerseBook(cells), [cells])
  const pack = useVoicesPack(wanted ? book : null)

  const index = useMemo(() => (pack?.ok ? voiceIndexFor(pack.version, pack.voices) : null), [pack])
  const shared = useMemo(() => sharedVerseRefs(cells), [cells])

  const multiLane = projectTargetLaneLanguages(project).length > 1
  const labelFor = useMemo(() => {
    if (!pack?.ok) return null
    const entities = pack.people.entities
    const options: VoiceLabelOptions = {
      mode: prefs.labelMode,
      interfaceLanguage: acaiLanguageForLocale(locale),
      projectNames: {
        concepts: project.terminology ?? [],
        termMatching: project.termMatching,
        sourceLanguage: acaiLanguageFor(project.sourceLanguage),
        multiLane,
      },
    }
    const cache = new Map<BkpEntityId, VoiceLabel | null>()
    return (entityId: BkpEntityId): VoiceLabel | null => {
      const cached = cache.get(entityId)
      if (cached !== undefined) return cached
      const entity = Object.hasOwn(entities, entityId) ? entities[entityId] : undefined
      const label = resolveVoiceLabel(entityId, entity, options)
      cache.set(entityId, label)
      return label
    }
  }, [pack, prefs.labelMode, locale, project.terminology, project.termMatching, project.sourceLanguage, multiLane])

  // The filter belongs to one file. Leaving the file drops it (React's
  // "adjust state when a prop changes" pattern, so no effect is needed).
  const [filter, setFilter] = useState<{ fileId: string; speaker: BkpEntityId } | null>(null)
  if (filter && filter.fileId !== fileId) setFilter(null)
  const showLinesBy = useCallback(
    (speaker: BkpEntityId) => {
      if (fileId) setFilter({ fileId, speaker })
    },
    [fileId],
  )
  const clearFilter = useCallback(() => setFilter(null), [])

  const context = useMemo<BibleVoicesContextValue | null>(
    () =>
      index && labelFor
        ? { index, shared, labelFor, showChips: prefs.voiceChips, showRails: prefs.speechRails, showLinesBy }
        : null,
    [index, shared, labelFor, prefs.voiceChips, prefs.speechRails, showLinesBy],
  )

  const speaker = context && filter?.fileId === fileId ? filter.speaker : null
  const filteredCellIds = useMemo(() => {
    if (!speaker || !index) return null
    // `cells` is built from `cellIds`, so the two line up by position.
    return cellIds.filter((_, position) => {
      const voices = cellVoicesFor(index, cells[position], shared)
      return voices !== null && speaksIn(voices, speaker)
    })
  }, [speaker, index, cellIds, cells, shared])
  const filteredSet = useMemo(() => (filteredCellIds ? new Set(filteredCellIds) : null), [filteredCellIds])
  const filterHides = useCallback(
    (cellId: string) => filteredSet !== null && !filteredSet.has(cellId) && cellIds.includes(cellId),
    [filteredSet, cellIds],
  )

  const filterInfo = useMemo<BibleVoicesFilter | null>(
    () =>
      speaker && filteredCellIds
        ? { speaker, label: labelFor?.(speaker) ?? null, count: filteredCellIds.length }
        : null,
    [speaker, filteredCellIds, labelFor],
  )

  return { context, filteredCellIds, filter: filterInfo, filterHides, clearFilter }
}
