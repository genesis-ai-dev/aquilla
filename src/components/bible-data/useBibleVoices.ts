// Voices in the editor (AQU-1687): the table-level half.
//
// EditorTable calls this (through useBibleData, AQU-1689) once per render. It:
//   • loads the pack's `voices` and `people` layers for the open book, only
//     while the project's Voices enrichment is on and the person shows chips
//     or rails (View settings → Bible data);
//   • builds the index once per (pack version, book);
//   • resolves names through the label chain (project names → interface
//     language → English, as the person chose).
// "Show every line by …" is one kind of Bible data cell filter, which
// useBibleData owns (AQU-1689). Rows read the result through
// BibleVoicesContext. Nothing here throws: an unavailable pack means no
// chips and no rails.

import { useEffect, useMemo, useState } from "react"
import { loadLayer, loadManifest, type BkpFailureReason } from "@/lib/bible-data/pack-client"
import type { BkpEntityId, BkpPeopleLayer, BkpRef, BkpVoicesLayer } from "@/lib/bible-data/pack-types"
import { mapLayerToProject } from "@/lib/bible-data/versification"
import { firstVerseBook, voiceIndexFor, type VoiceCellInput } from "@/lib/bible-data/voice-index"
import type { ProjectRecord } from "@/lib/parsers/types"
import { useBibleDataViewPrefs } from "@/lib/store/bible-data-view-prefs"
import { useEntityLabels } from "./useEntityLabels"
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
  /** The file's cells as verses, by position (see useVerseCells). */
  cells: readonly VoiceCellInput[]
  /** Verses that more than one cell of the file covers. */
  shared: ReadonlySet<BkpRef>
  /** The project has Voices on and the person shows chips or rails. */
  enabled: boolean
  /** Filter the editor to the cells where `speaker` speaks. */
  showLinesBy: (speaker: BkpEntityId) => void
}

/** What rows read through BibleVoicesContext; null while Voices shows nothing. */
export function useBibleVoices({
  project,
  cells,
  shared,
  enabled,
  showLinesBy,
}: BibleVoicesOptions): BibleVoicesContextValue | null {
  const prefs = useBibleDataViewPrefs()
  const book = useMemo(() => (enabled ? firstVerseBook(cells) : null), [enabled, cells])
  const pack = useVoicesPack(book)

  const index = useMemo(() => (pack?.ok ? voiceIndexFor(pack.version, pack.voices) : null), [pack])
  const labelFor = useEntityLabels(project, pack?.ok ? pack.people.entities : null)

  return useMemo<BibleVoicesContextValue | null>(
    () =>
      index && labelFor
        ? { index, shared, labelFor, showChips: prefs.voiceChips, showRails: prefs.speechRails, showLinesBy }
        : null,
    [index, shared, labelFor, prefs.voiceChips, prefs.speechRails, showLinesBy],
  )
}
