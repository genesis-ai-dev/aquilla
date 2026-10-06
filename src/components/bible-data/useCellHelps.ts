// Translation helps in the cell's Context tab (AQU-1695): the `notes` and
// `terms` layers, loaded by the tab itself.
//
// The notes layer is big (about 1.3 MB raw for John), so nothing loads it
// until a Context tab opens for the book, and only while Translation helps is
// on; key terms load the same way, only while Key terms is on. The pack
// client keeps one promise per file of the open book, so every later tab, in
// any cell of the book, reads it from memory. Nothing here throws: a failure is a
// typed reason, and a later tab retries (the client never remembers one).

import { useEffect, useState } from "react"
import { noteWords, notesFor, notesIndexFor, questionsFor, type CellNotes } from "@/lib/bible-data/helps-index"
import { loadLayer, type BkpFailureReason, type BkpResult } from "@/lib/bible-data/pack-client"
import type { BkpLayerData, BkpQuestion, BkpRef, BkpTermsLayer, BkpWordId } from "@/lib/bible-data/pack-types"
import { mapLayerToProject } from "@/lib/bible-data/versification"
import type { BkpLayer } from "../../../db/shared/bible-enrichments"

/** One layer of `book` while `wanted`: null while it loads, and while it is not wanted. */
function useLayerWhileOpen<L extends BkpLayer>(
  layer: L,
  book: string,
  wanted: boolean,
): BkpResult<BkpLayerData[L]> | null {
  const key = wanted ? `${layer}|${book}` : null
  const [state, setState] = useState<{ key: string; result: BkpResult<BkpLayerData[L]> } | null>(null)
  useEffect(() => {
    if (!key) return
    let live = true
    void loadLayer(layer, book)
      .catch((): BkpResult<BkpLayerData[L]> => ({ ok: false, reason: "offline" }))
      .then((result) => {
        if (!live) return
        setState({ key, result: result.ok ? { ok: true, value: mapLayerToProject(result.value) } : result })
      })
    return () => {
      live = false
    }
  }, [key, layer, book])
  return key && state?.key === key ? state.result : null
}

/**
 * The Translation Notes and Questions of a cell's verses:
 *   off         — Translation helps is off; nothing was fetched;
 *   loading     — the notes layer is on its way;
 *   unavailable — it did not load (`not-found` is a book the pack has no
 *                 notes for, which says nothing);
 *   ready       — the cell's notes and questions, either list maybe empty.
 */
export type CellHelpsState =
  | { status: "off" }
  | { status: "loading" }
  | { status: "unavailable"; reason: BkpFailureReason }
  | { status: "ready"; notes: CellNotes; questions: readonly BkpQuestion[] }

export interface CellHelps {
  notes: CellHelpsState
  /** The book's key terms; null while Key terms is off, loading, or unavailable. */
  terms: BkpTermsLayer | null
  /** Each anchored note's number (from 1), by the words it highlights. */
  noteNumbers: ReadonlyMap<BkpWordId, readonly number[]>
  /** The ids of the notes that highlight each word, for its data attribute. */
  noteIds: ReadonlyMap<BkpWordId, readonly string[]>
}

export interface CellHelpsOptions {
  book: string
  refs: readonly BkpRef[]
  /** Translation helps is on. */
  notes: boolean
  /** Key terms is on. */
  terms: boolean
}

export function useCellHelps({ book, refs, notes: notesOn, terms: termsOn }: CellHelpsOptions): CellHelps {
  const notesLayer = useLayerWhileOpen("notes", book, notesOn)
  const termsLayer = useLayerWhileOpen("terms", book, termsOn)

  let notes: CellHelpsState
  if (!notesOn) notes = { status: "off" }
  else if (!notesLayer) notes = { status: "loading" }
  else if (!notesLayer.ok) notes = { status: "unavailable", reason: notesLayer.reason }
  else {
    const index = notesIndexFor(notesLayer.value)
    notes = { status: "ready", notes: notesFor(index, refs), questions: questionsFor(index, refs) }
  }

  const noteNumbers = new Map<BkpWordId, number[]>()
  const noteIds = new Map<BkpWordId, string[]>()
  if (notes.status === "ready") {
    notes.notes.anchored.forEach((note, position) => {
      for (const wordId of new Set(noteWords(note))) {
        noteNumbers.set(wordId, [...(noteNumbers.get(wordId) ?? []), position + 1])
        noteIds.set(wordId, [...(noteIds.get(wordId) ?? []), note.id])
      }
    })
  }

  return { notes, terms: termsLayer?.ok ? termsLayer.value : null, noteNumbers, noteIds }
}
