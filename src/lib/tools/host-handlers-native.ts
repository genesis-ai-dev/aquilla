/**
 * Bridge handlers added in apiRev 8 — integrating Smart Extensions directly
 * into Aquilla's real native `EditorTable` (active-cell sync, reveal,
 * declarative row badges/spans/columns, and opening the extension's side panel).
 */

import { BridgeError, type BridgeHandler } from "./host-bridge"
import {
  parseAnnotateInput,
  type ExtensionAnnotateInput,
  type NativeActiveCell,
} from "../../../shared/tools/native-editor"

export interface ToolNativeEditorHostData {
  /** Currently focused cell in the real native editor (or null). */
  getActiveCell: () => Promise<NativeActiveCell | null>
  /** Scroll/flash/focus a cell in the real native editor. */
  revealInEditor: (fileId: string, cellId: string, focus: boolean) => Promise<boolean>
  /** Publish declarative badges, span highlights/fixes, and column cells into the native editor. */
  annotateEditor: (input: ExtensionAnnotateInput) => Promise<{ cells: number }>
  /** Clear annotations previously published by this extension. */
  clearEditorAnnotations: (fileId: string | null, layer: string | null) => Promise<boolean>
  /** Open this extension in the workspace's left dock panel. */
  openOwnPanel: () => Promise<boolean>
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function bad(message: string): never {
  throw new BridgeError("invalid_params", message)
}

function str(v: unknown, name: string, max = 200): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max) bad(`${name} must be a non-empty string`)
  return v
}

export function createNativeEditorHandlers(data: ToolNativeEditorHostData): Record<string, BridgeHandler> {
  return {
    "editor.activeCell": async () => data.getActiveCell(),
    "editor.reveal": async (params) => {
      if (!isRecord(params)) bad("params must be an object")
      const fileId = str(params.fileId, "fileId")
      const cellId = str(params.cellId, "cellId")
      const focus = params.focus !== false
      return data.revealInEditor(fileId, cellId, focus)
    },
    "editor.annotate": async (params) => {
      const parsed = parseAnnotateInput(params)
      if (!parsed.ok) bad(parsed.error)
      return data.annotateEditor(parsed.value)
    },
    "editor.clearAnnotations": async (params) => {
      const p = isRecord(params) ? params : {}
      const fileId = typeof p.fileId === "string" && p.fileId.trim() ? p.fileId.trim().slice(0, 200) : null
      const layer = typeof p.layer === "string" && p.layer.trim() ? p.layer.trim().slice(0, 64) : null
      return data.clearEditorAnnotations(fileId, layer)
    },
    "ui.openPanel": async () => data.openOwnPanel(),
  }
}

export function stubNativeEditorData(populated: boolean): ToolNativeEditorHostData {
  return {
    getActiveCell: async () =>
      populated
        ? { fileId: "f1", cellId: "c1", ref: "MAT 1:1", source: "The book of the genealogy of Jesus Christ", target: "Libro de la genealogía de Jesucristo" }
        : null,
    revealInEditor: async () => true,
    annotateEditor: async (input) => ({ cells: Object.keys(input.cells).length }),
    clearEditorAnnotations: async () => true,
    openOwnPanel: async () => true,
  }
}
