import { useEffect, useState } from "react"
import * as Y from "yjs"
import { loadFileDoc, destroyFileDoc } from "@/lib/store/file-doc"
import { computeSectionProgress, type SectionProgress } from "@/lib/progress/section-progress"
import type { ValidationEntry } from "@/lib/codex-editor/types"
import { getPlainText } from "@/lib/richtext/translated-xml"

/**
 * Lazily read a file's Y.Doc from IndexedDB and compute section progress.
 * Ref-counted via loadFileDoc, so if the editor is already showing this file
 * the doc is shared — no duplicate hydration.
 */
export function useSectionProgress(
  fileId: string | null,
  validationCount: number,
): SectionProgress[] | null {
  const [sections, setSections] = useState<SectionProgress[] | null>(null)

  useEffect(() => {
    if (!fileId) { setSections(null); return }

    const handle = loadFileDoc(fileId)
    let cancelled = false

    function compute() {
      if (cancelled) return
      const cellsMap = handle.doc.getMap("cells")
      const orderArray = handle.doc.getArray<string>("order")
      const ordered: Array<{
        id: string
        group: string
        translated: string
        activeValidators: string[]
        audioUrl?: string
      }> = []

      for (const id of orderArray.toArray()) {
        const cell = cellsMap.get(id) as Y.Map<unknown> | undefined
        if (!cell) continue
        const frag = cell.get("translatedXml") as Y.XmlFragment | undefined
        const translated = frag ? getPlainText(frag) : ((cell.get("translated") as string) || "")
        const source = cell.get("__source") as
          | { metadata?: { edits?: Array<{ editMap?: string[]; validatedBy?: ValidationEntry[] }>; selectedAudioId?: string } }
          | undefined
        let activeValidators: string[] = []
        if (source?.metadata?.edits) {
          for (let i = source.metadata.edits.length - 1; i >= 0; i--) {
            const edit = source.metadata.edits[i]
            if (edit.editMap?.[0] === "value") {
              activeValidators = (edit.validatedBy ?? [])
                .filter(v => v && typeof v.username === "string" && !v.isDeleted)
                .map(v => v.username)
              break
            }
          }
        }
        ordered.push({
          id: cell.get("id") as string,
          group: (cell.get("group") as string) || "",
          translated,
          activeValidators,
          audioUrl: source?.metadata?.selectedAudioId,
        })
      }
      setSections(computeSectionProgress(ordered, validationCount))
    }

    function onSynced() { compute() }

    if (handle.persistence.synced) compute()
    else handle.persistence.once("synced", onSynced)

    const cellsMap = handle.doc.getMap("cells")
    const orderArray = handle.doc.getArray<string>("order")
    cellsMap.observeDeep(compute)
    orderArray.observe(compute)

    return () => {
      cancelled = true
      cellsMap.unobserveDeep(compute)
      orderArray.unobserve(compute)
      destroyFileDoc(handle)
    }
  }, [fileId, validationCount])

  return sections
}
