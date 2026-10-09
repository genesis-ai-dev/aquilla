/**
 * Bridge handlers added in apiRev 3 — the surfaces an `editor` extension
 * needs for full parity with the built-in editor. Param validation only; the
 * live implementation is LiveToolData over the workspace's editor services
 * (editor-services.ts), the smoke render passes a stub. Every method here is
 * additive: apiRev 1/2 extensions never call them.
 */

import { BridgeError, type BridgeHandler } from "./host-bridge"
import type {
  ToolBacktranslation,
  ToolCellSignals,
  ToolEditorConfig,
  ToolLens,
  ToolPresencePeer,
  ToolSection,
  ToolSuggestion,
  ToolTermMatch,
  ToolPericope,
} from "../../../shared/tools/editor-api"

export type ToolSettingsSection = "target-language" | "lanes" | "terminology"
const SETTINGS: readonly ToolSettingsSection[] = ["target-language", "lanes", "terminology"]

export interface ToolTypingParams {
  anchor: number
  head: number
  draftText: string
}

export interface ToolEditorHostData {
  editorConfig: (fileId: string) => Promise<ToolEditorConfig>
  setLane: (fileId: string, tag: string) => Promise<boolean>
  setLens: (lens: ToolLens) => Promise<boolean>
  openSettings: (section: ToolSettingsSection) => Promise<boolean>
  sections: (fileId: string) => Promise<ToolSection[]>
  signals: (fileId: string) => Promise<ToolCellSignals>
  pericopes: (fileId: string) => Promise<ToolPericope[]>
  settle: (fileId: string, cellId: string) => Promise<boolean>
  termMatches: (fileId: string, cellIds: string[]) => Promise<Record<string, ToolTermMatch[]>>
  openTerm: (conceptId: string) => Promise<boolean>
  draft: (fileId: string, cellIds: string[], opts: { regenerate: boolean }) => Promise<boolean>
  draftParagraph: (fileId: string, cellId: string) => Promise<boolean>
  listBacktranslations: (fileId: string) => Promise<Record<string, ToolBacktranslation>>
  runBacktranslation: (fileId: string, cellId: string) => Promise<boolean>
  saveBacktranslation: (fileId: string, cellId: string, text: string) => Promise<boolean>
  openHistory: (fileId: string, cellId: string) => Promise<boolean>
  openAttachments: (fileId: string, cellId: string) => Promise<boolean>
  openRule: (fileId: string, cellId: string, ruleId: string) => Promise<boolean>
  listPeers: (fileId: string) => Promise<ToolPresencePeer[]>
  typing: (fileId: string, cellId: string, selection: ToolTypingParams | null) => Promise<boolean>
  viewing: (fileId: string, cellId: string | null) => Promise<boolean>
  recordAudio: (fileId: string, cellId: string) => Promise<boolean>
  generateAudio: (fileId: string, cellId: string) => Promise<boolean>
  setSelection: (fileId: string, cellIds: string[]) => Promise<boolean>
  suggest: (fileId: string, cellId: string, prefix: string) => Promise<ToolSuggestion[]>
  suggestionFeedback: (fileId: string, cellId: string, suggestionId: string, accepted: boolean) => Promise<boolean>
}

export const MAX_DRAFT_CELLS = 200
export const MAX_SELECTION = 200
const MAX_ID = 200

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function bad(message: string): never {
  throw new BridgeError("invalid_params", message)
}

function str(v: unknown, name: string, max = MAX_ID): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max) bad(`${name} must be a non-empty string`)
  return v
}

function obj(params: unknown): Record<string, unknown> {
  if (!isRecord(params)) bad("params must be an object")
  return params
}

function file(params: unknown): string {
  return str(obj(params).fileId, "fileId")
}

function cell(params: unknown): { fileId: string; cellId: string } {
  const p = obj(params)
  return { fileId: str(p.fileId, "fileId"), cellId: str(p.cellId, "cellId") }
}

function ids(v: unknown, name: string, max: number): string[] {
  if (!Array.isArray(v)) bad(`${name} must be an array`)
  if (v.length > max) bad(`at most ${max} ${name} per call`)
  return v.map((id, i) => str(id, `${name}[${i}]`))
}

const LENSES: readonly ToolLens[] = ["text", "audio", "agent"]

function nonNegInt(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) bad(`${name} must be a non-negative integer`)
  return v
}

export function createEditorHandlers(data: ToolEditorHostData): Record<string, BridgeHandler> {
  return {
    "editor.config": async (params) => data.editorConfig(file(params)),
    "editor.setLane": async (params) => {
      const p = obj(params)
      if (typeof p.lane !== "string" || p.lane.length > 100) bad("lane must be a string")
      return data.setLane(file(params), p.lane)
    },
    "editor.setLens": async (params) => {
      const lens = obj(params).lens
      if (typeof lens !== "string" || !(LENSES as readonly string[]).includes(lens)) bad(`lens must be one of ${LENSES.join(", ")}`)
      return data.setLens(lens as ToolLens)
    },
    "editor.openSettings": async (params) => {
      const section = obj(params).section
      if (typeof section !== "string" || !(SETTINGS as readonly string[]).includes(section)) bad(`section must be one of ${SETTINGS.join(", ")}`)
      return data.openSettings(section as ToolSettingsSection)
    },
    "cells.sections": async (params) => data.sections(file(params)),
    "cells.signals": async (params) => data.signals(file(params)),
    "cells.pericopes": async (params) => data.pericopes(file(params)),
    "cells.settle": async (params) => {
      const ref = cell(params)
      return data.settle(ref.fileId, ref.cellId)
    },
    "terms.matches": async (params) => data.termMatches(file(params), ids(obj(params).cellIds, "cellIds", 500)),
    "terms.open": async (params) => data.openTerm(str(obj(params).conceptId, "conceptId")),
    "ai.draft": async (params) => {
      const p = obj(params)
      const cellIds = ids(p.cellIds, "cellIds", MAX_DRAFT_CELLS)
      if (cellIds.length === 0) bad("cellIds must not be empty")
      return data.draft(file(params), cellIds, { regenerate: p.regenerate === true })
    },
    "ai.draftParagraph": async (params) => {
      const ref = cell(params)
      return data.draftParagraph(ref.fileId, ref.cellId)
    },
    "backtranslation.list": async (params) => data.listBacktranslations(file(params)),
    "backtranslation.run": async (params) => {
      const ref = cell(params)
      return data.runBacktranslation(ref.fileId, ref.cellId)
    },
    "backtranslation.save": async (params) => {
      const ref = cell(params)
      const text = obj(params).text
      if (typeof text !== "string" || text.length > 20_000) bad("text must be a string of at most 20000 characters")
      return data.saveBacktranslation(ref.fileId, ref.cellId, text)
    },
    "history.open": async (params) => {
      const ref = cell(params)
      return data.openHistory(ref.fileId, ref.cellId)
    },
    "attachments.open": async (params) => {
      const ref = cell(params)
      return data.openAttachments(ref.fileId, ref.cellId)
    },
    "rules.open": async (params) => {
      const ref = cell(params)
      return data.openRule(ref.fileId, ref.cellId, str(obj(params).ruleId, "ruleId"))
    },
    "presence.peers": async (params) => data.listPeers(file(params)),
    "presence.typing": async (params) => {
      const ref = cell(params)
      const sel = obj(params).selection
      if (sel === null || sel === undefined) return data.typing(ref.fileId, ref.cellId, null)
      if (!isRecord(sel)) bad("selection must be an object or null")
      const draftText = typeof sel.draftText === "string" ? sel.draftText.slice(0, 20_000) : ""
      return data.typing(ref.fileId, ref.cellId, {
        anchor: nonNegInt(sel.anchor, "selection.anchor"),
        head: nonNegInt(sel.head, "selection.head"),
        draftText,
      })
    },
    "presence.view": async (params) => {
      const p = obj(params)
      const cellId = p.cellId === null || p.cellId === undefined ? null : str(p.cellId, "cellId")
      return data.viewing(file(params), cellId)
    },
    "audio.record": async (params) => {
      const ref = cell(params)
      return data.recordAudio(ref.fileId, ref.cellId)
    },
    "audio.generate": async (params) => {
      const ref = cell(params)
      return data.generateAudio(ref.fileId, ref.cellId)
    },
    "selection.set": async (params) => data.setSelection(file(params), ids(obj(params).cellIds, "cellIds", MAX_SELECTION)),
    "suggestions.get": async (params) => {
      const ref = cell(params)
      const prefix = obj(params).prefix
      if (typeof prefix !== "string" || prefix.length > 20_000) bad("prefix must be a string")
      return data.suggest(ref.fileId, ref.cellId, prefix)
    },
    "suggestions.feedback": async (params) => {
      const ref = cell(params)
      const p = obj(params)
      return data.suggestionFeedback(ref.fileId, ref.cellId, str(p.suggestionId, "suggestionId"), p.accepted === true)
    },
  }
}
