/**
 * Mirror: Y.Doc translatedXml → cells.translation_text + outbox.
 *
 * Each registered Y.Doc has a `cells` Y.Map keyed by cellId. Each cell value
 * is a Y.Map containing a `translatedXml` Y.XmlFragment (TipTap's CRDT) and
 * optionally a `translated` plain-text fallback. We observe the cells map
 * deeply; on any change we derive plain text for the affected cell, write
 * it to local-store, and enqueue a `cell.set_translation` mutation.
 *
 * Design choices (see DATA_PERSISTENCE_PLAN.md §8.8):
 * - Mirror only updates *existing* rows. It never creates cells from Y.Doc
 *   alone — those flow through snapshot ingest or the importer. If a cellId
 *   appears in Y.Doc with no local row, the change is silently dropped.
 * - The bootstrap is a no-op. Cells exist via snapshot/importer; the local
 *   store is canonical. Y.Doc is a fallback for live edits only.
 * - Writes are fire-and-forget per change. SQLite-WASM serializes them; the
 *   observer fires at most once per Y.Doc transaction quiesce, so the race
 *   surface is small. Per-cell debouncing can be added if profiling shows
 *   redundant outbox writes during heavy typing.
 */

import * as Y from "yjs"
import {
  enqueueOutboxRecord,
  getCell,
  upsertCell,
  type CellRow,
} from "@/lib/local-store"
import type { Mirror, MirrorContext } from "./registry"

export interface TranslationTextMirrorOptions {
  yDoc: Y.Doc
}

export function createTranslationTextMirror(
  opts: TranslationTextMirrorOptions,
): Mirror {
  const { yDoc } = opts

  return {
    name: "translation-text",
    async bootstrap() {
      // Intentionally empty. Cells arrive via snapshot ingest or importer;
      // Y.Doc only contributes live edits once cells already exist.
    },
    attach(ctx) {
      const cellsMap = yDoc.getMap("cells")
      const handler = (events: Array<Y.YEvent<Y.AbstractType<unknown>>>) => {
        const dirty = new Set<string>()
        for (const event of events) {
          for (const key of event.changes.keys.keys()) {
            dirty.add(key)
          }
          const path = event.path
          if (typeof path[0] === "string") {
            dirty.add(path[0])
          }
        }
        for (const cellId of dirty) {
          void syncCell(ctx, cellsMap, cellId)
        }
      }
      cellsMap.observeDeep(handler)
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        cellsMap.unobserveDeep(handler)
      }
    },
  }
}

async function syncCell(
  ctx: MirrorContext,
  cellsMap: Y.Map<unknown>,
  cellId: string,
): Promise<void> {
  const yCell = cellsMap.get(cellId)
  if (!yCell) return
  const newText = derivePlainText(yCell)

  const existing = await getCell(ctx.store, cellId)
  if (!existing) return
  if (existing.translation_text === newText) return

  const newVersion = existing.version + 1
  const updated: CellRow = {
    ...existing,
    translation_text: newText,
    version: newVersion,
    last_edited_by: ctx.actorId,
    last_edited_at: ctx.now(),
    updated_at: ctx.now(),
  }
  await upsertCell(ctx.store, updated)
  await enqueueOutboxRecord(ctx.store, {
    local_id: `${cellId}@v${newVersion}-${ctx.now()}`,
    project_id: existing.project_id,
    endpoint: `/projects/${existing.project_id}/cells/${cellId}`,
    payload: JSON.stringify({
      kind: "cell.set_translation",
      translation_text: newText,
      expected_version: existing.version,
    }),
    expected_version: existing.version,
    created_at: ctx.now(),
  })
}

/**
 * Walk a cell's Y data and produce plain text. Prefers `translatedXml`
 * (a Y.XmlFragment of paragraph elements) and falls back to the
 * `translated` plain string. Paragraphs join with newlines; placeholder
 * tokens (`{g1}…{/g1}`, `{f1}`) survive because they live inside text
 * nodes, not as XML elements.
 */
function derivePlainText(yCell: unknown): string {
  if (!(yCell instanceof Y.Map)) return ""
  const fragment = yCell.get("translatedXml")
  if (fragment instanceof Y.XmlFragment) {
    return collectFragmentText(fragment)
  }
  const plain = yCell.get("translated")
  return typeof plain === "string" ? plain : ""
}

function collectFragmentText(fragment: Y.XmlFragment): string {
  const parts: string[] = []
  for (const child of fragment.toArray()) {
    parts.push(collectNodeText(child))
  }
  return parts.join("\n").replace(/\n+$/g, "")
}

function collectNodeText(node: Y.XmlElement | Y.XmlText | Y.XmlHook): string {
  if (node instanceof Y.XmlText) {
    return node.toString()
  }
  if (node instanceof Y.XmlElement) {
    const inner: string[] = []
    for (const child of node.toArray()) {
      inner.push(collectNodeText(child as Y.XmlElement | Y.XmlText | Y.XmlHook))
    }
    return inner.join("")
  }
  return ""
}
