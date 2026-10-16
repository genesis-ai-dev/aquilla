// Scripture place labels for the project comments list.
// A verse is "Genesis 1:2". A heading with no verse of its own uses the
// chapter it belongs to ("Genesis 1"). The cell id is never shown.

import { useEffect, useMemo, useState } from "react"
import type { CommentRecord } from "@/lib/sync/comments-read-types"
import { fetchCellsByIds } from "@/lib/sync/cells-read"
import { getBookName } from "@/lib/file-labeling/bible-book-names"
import { parseCanonicalRef } from "@/lib/progress/canonical-rollup"
import { parseScriptureReference } from "@/lib/scripture-reference"

export function cellPlaceKey(fileId: string, cellId: string): string {
  return `${fileId}\0${cellId}`
}

/** `GEN 1:2` → `Genesis 1:2`. `GEN 1` → `Genesis 1`. */
export function formatScriptureRef(value: string | null | undefined): string | null {
  const parsed = parseScriptureReference(value)
  if (parsed) {
    return parsed.verse
      ? `${parsed.bookName} ${parsed.chapter}:${parsed.verse}`
      : `${parsed.bookName} ${parsed.chapter}`
  }
  const loose = parseCanonicalRef(value)
  if (!loose) return null
  const name = getBookName(loose.book) ?? loose.book
  return `${name} ${loose.chapter}:${loose.verse}`
}

interface PlaceRow {
  cellId: string
  side: "source" | "target"
  canonicalRef?: string | null
  metadata?: Record<string, unknown> | null
}

/** Book, chapter, and verse when the cell has them; otherwise its chapter. */
export function cellPlaceLabel(row: PlaceRow): string | null {
  return formatScriptureRef(row.canonicalRef) ?? labelFromImport(row.metadata)
}

function labelFromImport(metadata: Record<string, unknown> | null | undefined): string | null {
  const envelope = metadata?.aquillaImport
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return null
  const record = envelope as Record<string, unknown>
  const address = record.address
  if (address && typeof address === "object" && !Array.isArray(address)) {
    const fields = address as Record<string, unknown>
    if (fields.scheme === "scripture" && typeof fields.book === "string") {
      const name = getBookName(fields.book) ?? fields.book
      const chapter = fields.chapter
      const verse = fields.verse
      if (name && (typeof chapter === "number" || typeof chapter === "string")) {
        if (typeof verse === "string" && verse.trim()) return `${name} ${chapter}:${verse.trim()}`
        if (typeof verse === "number") return `${name} ${chapter}:${verse}`
        return `${name} ${chapter}`
      }
    }
  }
  const milestone = record.milestone
  if (milestone && typeof milestone === "object" && !Array.isArray(milestone)) {
    const label = (milestone as Record<string, unknown>).label
    if (typeof label === "string" && label.trim()) return label.trim()
  }
  return null
}

/** One place label per cell, taken from the source row when both sides exist. */
export function placeLabelsByCell(rows: readonly PlaceRow[]): Map<string, string> {
  const grouped = new Map<string, PlaceRow[]>()
  for (const row of rows) {
    const list = grouped.get(row.cellId) ?? []
    list.push(row)
    grouped.set(row.cellId, list)
  }
  const out = new Map<string, string>()
  for (const [cellId, group] of grouped) {
    const source = group.find((row) => row.side === "source") ?? group[0]
    const label = source ? cellPlaceLabel(source) : null
    if (label) out.set(cellId, label)
  }
  return out
}

/**
 * Load a book/chapter/verse label for every cell a thread is attached to.
 * Keyed by fileId + cellId. A failed read leaves that cell out of the map.
 */
export function useCommentCellPlaces(
  projectId: string | undefined,
  getToken: (fileId: string) => Promise<string | null>,
  comments: readonly CommentRecord[],
): Map<string, string> {
  const [places, setPlaces] = useState<Map<string, string>>(() => new Map())
  const cellKeys = useMemo(() => {
    const seen = new Set<string>()
    for (const comment of comments) {
      if (comment.scopeKind !== "cell" || !comment.fileId || !comment.cellId) continue
      seen.add(cellPlaceKey(comment.fileId, comment.cellId))
    }
    return [...seen].sort().join("\n")
  }, [comments])

  useEffect(() => {
    if (!projectId || !cellKeys) {
      setPlaces(new Map())
      return
    }
    let cancelled = false
    const byFile = new Map<string, string[]>()
    for (const line of cellKeys.split("\n")) {
      const splitAt = line.indexOf("\0")
      const fileId = line.slice(0, splitAt)
      const cellId = line.slice(splitAt + 1)
      const list = byFile.get(fileId) ?? []
      list.push(cellId)
      byFile.set(fileId, list)
    }
    void (async () => {
      const next = new Map<string, string>()
      await Promise.all(
        [...byFile].map(async ([fileId, cellIds]) => {
          try {
            const token = await getToken(fileId)
            if (!token || cancelled) return
            const rows = await fetchCellsByIds(projectId, fileId, cellIds, token)
            for (const [cellId, label] of placeLabelsByCell(rows)) {
              next.set(cellPlaceKey(fileId, cellId), label)
            }
          } catch {
            // Leave this file's cells absent; the row shows the file name.
          }
        }),
      )
      if (!cancelled) setPlaces(next)
    })()
    return () => {
      cancelled = true
    }
  }, [projectId, cellKeys, getToken])

  return places
}
