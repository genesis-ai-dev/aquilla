// Who's Who, the pack layers it reads (AQU-1689).
//
// `people` is required: without it there is nothing to show. `structure`
// (pericopes, for the cast) and `text` (the words, for tints, the Context tab
// and telling "I" from "him") are each optional: when one fails, the features
// that need it hide and the rest keep working. Nothing here throws; a failure
// is a typed reason, and a later mount retries (the pack client never
// remembers a failure).

import { useEffect, useState } from "react"
import { useRetryOnReconnect } from "./use-retry-on-reconnect"
import { loadLayer, loadManifest, type BkpFailureReason } from "@/lib/bible-data/pack-client"
import type { BkpPeopleLayer, BkpStructureLayer, BkpTextLayer } from "@/lib/bible-data/pack-types"
import { mapLayerToProject } from "@/lib/bible-data/versification"

export interface PeoplePackWants {
  structure: boolean
  text: boolean
}

export type PeoplePack =
  | {
      ok: true
      book: string
      version: string
      people: BkpPeopleLayer
      structure: BkpStructureLayer | null
      text: BkpTextLayer | null
    }
  | { ok: false; book: string; reason: BkpFailureReason }

/** One book's people layer, with structure and text when wanted and available, in the project's versification. */
export async function loadPeoplePack(book: string, wants: PeoplePackWants): Promise<PeoplePack> {
  try {
    const [manifest, people, structure, text] = await Promise.all([
      loadManifest(),
      loadLayer("people", book),
      wants.structure ? loadLayer("structure", book) : null,
      wants.text ? loadLayer("text", book) : null,
    ])
    if (!manifest.ok) return { ok: false, book, reason: manifest.reason }
    if (!people.ok) return { ok: false, book, reason: people.reason }
    return {
      ok: true,
      book,
      version: manifest.value.version,
      people: mapLayerToProject(people.value),
      structure: structure?.ok ? mapLayerToProject(structure.value) : null,
      text: text?.ok ? mapLayerToProject(text.value) : null,
    }
  } catch {
    return { ok: false, book, reason: "offline" }
  }
}

/** The pack for `book` (null while it loads, or with no book). Reloads when the book or the wants change. */
export function usePeoplePack(book: string | null, wants: PeoplePackWants): PeoplePack | null {
  const [pack, setPack] = useState<{ key: string; pack: PeoplePack } | null>(null)
  const key = book ? `${book}|${wants.structure ? "s" : ""}${wants.text ? "t" : ""}` : null
  const current = key && pack?.key === key ? pack.pack : null
  // AQU-1692: a book that failed offline loads again on reconnecting.
  const attempt = useRetryOnReconnect(current?.ok === false && current.reason === "offline")
  useEffect(() => {
    if (!book || !key) return
    let live = true
    void loadPeoplePack(book, { structure: wants.structure, text: wants.text }).then((next) => {
      if (live) setPack({ key, pack: next })
    })
    return () => {
      live = false
    }
  }, [book, key, wants.structure, wants.text, attempt])
  return current
}
