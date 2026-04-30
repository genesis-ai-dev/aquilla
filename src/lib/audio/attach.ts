// Writes a new audio attachment + selectedAudioId onto a cell's __source
// metadata inside a single Y.Doc transaction. Triggers the existing useCells
// observer which surfaces attachments/selectedAudioId on the next render.

import * as Y from "yjs"
import type { CodexCell, CodexCellAttachment } from "@/lib/codex-editor/types"

export function attachAudioToCell(
  doc: Y.Doc,
  cellId: string,
  args: {
    audioId: string
    url: string
    username: string
    mimeType?: string
    slot?: "recording" | "generatedVoice"
  },
): void {
  const cellsMap = doc.getMap("cells")
  const yCell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
  if (!yCell) throw new Error(`cell not found: ${cellId}`)

  doc.transact(() => {
    const prev = yCell.get("__source") as CodexCell | undefined
    const now = Date.now()
    const attachment: CodexCellAttachment & { createdBy?: string; mimeType?: string; audioKind?: string } = {
      url: args.url,
      type: "audio",
      createdAt: now,
      updatedAt: now,
      isDeleted: false,
      ...(args.mimeType ? { mimeType: args.mimeType } : {}),
      audioKind: args.slot === "generatedVoice" ? "generatedVoice" : "recording",
      createdBy: args.username,
    }

    // Clone to avoid mutating the existing Y.Map value in place — Yjs stores
    // JSON-ish values by reference and won't propagate in-place mutations.
    const next: CodexCell = prev
      ? JSON.parse(JSON.stringify(prev))
      : {
          kind: 2 as const,
          languageId: "html",
          value: "",
          metadata: { id: cellId, type: "text" as const },
        }
    if (!next.metadata) {
      next.metadata = { id: cellId, type: "text" }
    }
    next.metadata.attachments = {
      ...(next.metadata.attachments || {}),
      [args.audioId]: attachment,
    }
    if (args.slot === "generatedVoice") {
      next.metadata.selectedGeneratedVoiceAudioId = args.audioId
    } else {
      next.metadata.selectedAudioId = args.audioId
    }

    yCell.set("__source", next)
  })
}

export function softDeleteAudioAttachment(
  doc: Y.Doc,
  cellId: string,
  audioId: string,
): void {
  const cellsMap = doc.getMap("cells")
  const yCell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
  if (!yCell) return

  doc.transact(() => {
    const prev = yCell.get("__source") as CodexCell | undefined
    if (!prev?.metadata?.attachments?.[audioId]) return
    const next: CodexCell = JSON.parse(JSON.stringify(prev))
    const target = next.metadata.attachments![audioId]
    target.isDeleted = true
    target.updatedAt = Date.now()
    if (next.metadata.selectedAudioId === audioId || next.metadata.selectedGeneratedVoiceAudioId === audioId) {
      // Find the most recent non-deleted attachment as fallback, else clear.
      const remaining = Object.entries(next.metadata.attachments!)
        .filter(([id, a]) => id !== audioId && !a.isDeleted)
        .sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0))
      if (next.metadata.selectedAudioId === audioId) {
        next.metadata.selectedAudioId = remaining.find(([, a]) => {
          return (a as CodexCellAttachment & { audioKind?: string }).audioKind !== "generatedVoice"
        })?.[0]
      }
      if (next.metadata.selectedGeneratedVoiceAudioId === audioId) {
        next.metadata.selectedGeneratedVoiceAudioId = remaining.find(([, a]) => {
          return (a as CodexCellAttachment & { audioKind?: string }).audioKind === "generatedVoice"
        })?.[0]
      }
    }
    yCell.set("__source", next)
  })
}
