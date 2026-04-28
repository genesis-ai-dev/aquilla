import { useEffect, useState } from "react"
import * as Y from "yjs"
import type { ExamplePairing } from "@/lib/parsers/types"
import { loadFileDoc, destroyFileDoc, type FileDocHandle } from "@/lib/store/file-doc"
import { getPlainText } from "@/lib/richtext/translated-xml"

/** Minimal cell shape the dual-index actually needs from the pool. We don't
 *  build full CellData here because the pool is read-only and never reaches
 *  validation/comments/etc. */
export interface ExampleCell {
  id: string
  fileId: string
  original: string
  translated: string
  context: string
  group: string
  type: string
  section?: string
}

function whenSynced(handle: FileDocHandle): Promise<void> {
  return new Promise<void>((resolve) => {
    if (handle.persistence.synced) resolve()
    else handle.persistence.once("synced", () => resolve())
  })
}

async function loadPair(pair: ExamplePairing): Promise<ExampleCell[]> {
  const sourceHandle = loadFileDoc(pair.sourceFileId)
  const targetHandle = loadFileDoc(pair.targetFileId)
  try {
    await Promise.all([whenSynced(sourceHandle), whenSynced(targetHandle)])
    const sCells = sourceHandle.doc.getMap("cells")
    const sOrder = sourceHandle.doc.getArray<string>("order")
    const tCells = targetHandle.doc.getMap("cells")
    const out: ExampleCell[] = []
    for (const id of sOrder.toArray()) {
      const sc = sCells.get(id) as Y.Map<unknown> | undefined
      if (!sc) continue
      const tc = tCells.get(id) as Y.Map<unknown> | undefined
      const original = (sc.get("original") as string) || ""
      const frag = tc?.get("translatedXml") as Y.XmlFragment | undefined
      const translated = frag
        ? getPlainText(frag)
        : ((tc?.get("translated") as string) || "")
      out.push({
        id,
        fileId: pair.targetFileId,
        original,
        translated,
        context: (sc.get("context") as string) || "",
        group: (sc.get("group") as string) || "",
        type: (sc.get("type") as string) || "text",
        section: sc.get("section") as string | undefined,
      })
    }
    return out
  } finally {
    destroyFileDoc(sourceHandle)
    destroyFileDoc(targetHandle)
  }
}

/**
 * Load a flat cell pool from the configured (source, target) example
 * pairings. Returns `null` while loading, or when no pairings are
 * configured — callers should fall back to the active file's own cells in
 * that case (self-pair).
 *
 * One-shot: this does not subscribe to changes in the paired docs. AI
 * completion is invoked manually, so a slightly stale pool between runs
 * is acceptable. Re-renders on pairings-array identity change.
 */
export function useExamplePool(pairings: ExamplePairing[] | null | undefined): ExampleCell[] | null {
  const [pool, setPool] = useState<ExampleCell[] | null>(null)
  // Stable key for the effect: order-sensitive list of pair ids.
  const key = pairings && pairings.length > 0
    ? pairings.map((p) => `${p.sourceFileId}:${p.targetFileId}`).join(",")
    : ""

  useEffect(() => {
    if (!pairings || pairings.length === 0) {
      setPool(null)
      return
    }
    let cancelled = false
    Promise.all(pairings.map(loadPair))
      .then((arrs) => {
        if (cancelled) return
        setPool(arrs.flat())
      })
      .catch(() => {
        if (cancelled) return
        setPool(null)
      })
    return () => {
      cancelled = true
    }
    // pairings reference changes whenever the user updates the config;
    // `key` is the canonical fingerprint to avoid redundant reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return pool
}
