/**
 * Bridge handlers added in apiRev 4 (additive): audio validation, the Audio
 * lens's take, source editing and the cell menu, the AI surfaces next to a
 * cell, and the source selection toolbar. Param validation only; LiveToolData
 * implements them over the workspace's editor services, the smoke render
 * passes a stub (smoke-rev4.ts).
 */

import { BridgeError, type BridgeHandler } from "./host-bridge"
import type {
  ToolAudioValidation,
  ToolContextualDraft,
  ToolExample,
  ToolRect,
  ToolSmartEdit,
  ToolSourceActions,
  ToolTermSelection,
  ToolVoiceList,
  ToolVoiceTake,
} from "../../../shared/tools/editor-api-rev4"
import type { ToolOrigin } from "../../../shared/tools/manifest"

export interface ToolRev4HostData {
  audioTakes: (fileId: string) => Promise<ToolAudioValidation>
  validateAudio: (fileId: string, cellId: string, audioId: string, validated: boolean) => Promise<boolean>
  voiceTake: (fileId: string, cellId: string) => Promise<ToolVoiceTake | null>
  trimAudio: (fileId: string, cellId: string, audioId: string, startMs: number, endMs: number) => Promise<boolean>
  voices: (fileId: string) => Promise<ToolVoiceList>
  assignVoice: (fileId: string, cellId: string, voiceId: string | null) => Promise<boolean>
  cloneVoice: (fileId: string, cellId: string) => Promise<boolean>
  sourceActions: (fileId: string, cellId: string) => Promise<ToolSourceActions>
  commitSource: (fileId: string, cellId: string, value: string, html: string | null) => Promise<boolean>
  setCellHidden: (fileId: string, cellId: string, hidden: boolean) => Promise<boolean>
  insertCell: (fileId: string, cellId: string, side: "above" | "below") => Promise<boolean>
  removeCell: (fileId: string, cellId: string) => Promise<boolean>
  retimeCell: (fileId: string, cellId: string, startSec: number, endSec: number) => Promise<boolean>
  examples: (fileId: string, cellId: string) => Promise<ToolExample[]>
  contextualDrafts: (fileId: string) => Promise<Record<string, ToolContextualDraft>>
  reviewContextual: (fileId: string, cellId: string, draftId: string, accept: boolean) => Promise<boolean>
  smartEdits: (fileId: string, cellId: string) => Promise<ToolSmartEdit[]>
  smartEditFeedback: (fileId: string, cellId: string, id: string, action: "accept" | "dismiss") => Promise<boolean>
  termSelection: (fileId: string, cellId: string, text: string) => Promise<ToolTermSelection>
  viewTerm: (fileId: string, cellId: string, text: string, rect: ToolRect) => Promise<boolean>
  addTerm: (fileId: string, cellId: string, text: string, rect: ToolRect) => Promise<boolean>
  askAi: (fileId: string, cellId: string, text: string) => Promise<boolean>
}

const MAX_ID = 200
const MAX_TEXT = 20_000

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
function bad(message: string): never {
  throw new BridgeError("invalid_params", message)
}
function obj(params: unknown): Record<string, unknown> {
  if (!isRecord(params)) bad("params must be an object")
  return params
}
function str(v: unknown, name: string, max = MAX_ID): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max) bad(`${name} must be a non-empty string`)
  return v
}
function text(v: unknown, name: string, max = MAX_TEXT): string {
  if (typeof v !== "string" || v.length > max) bad(`${name} must be a string of at most ${max} characters`)
  return v
}
function num(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) bad(`${name} must be a non-negative number`)
  return v
}
function file(params: unknown): string {
  return str(obj(params).fileId, "fileId")
}
function cell(params: unknown): { fileId: string; cellId: string; p: Record<string, unknown> } {
  const p = obj(params)
  return { fileId: str(p.fileId, "fileId"), cellId: str(p.cellId, "cellId"), p }
}
function rect(v: unknown): ToolRect {
  if (!isRecord(v)) bad("rect must be an object")
  return { left: Number(v.left) || 0, top: Number(v.top) || 0, width: Number(v.width) || 0, height: Number(v.height) || 0 }
}
function selection(v: unknown): string {
  const s = text(v, "text", 500).trim()
  if (!s) bad("text must not be empty")
  return s
}

export function createRev4Handlers(data: ToolRev4HostData): Record<string, BridgeHandler> {
  return {
    "audio.takes": async (params) => data.audioTakes(file(params)),
    "audio.validate": async (params) => {
      const c = cell(params)
      return data.validateAudio(c.fileId, c.cellId, str(c.p.audioId, "audioId"), true)
    },
    "audio.unvalidate": async (params) => {
      const c = cell(params)
      return data.validateAudio(c.fileId, c.cellId, str(c.p.audioId, "audioId"), false)
    },
    "audio.take": async (params) => {
      const c = cell(params)
      return data.voiceTake(c.fileId, c.cellId)
    },
    "audio.trim": async (params) => {
      const c = cell(params)
      const start = num(c.p.startMs, "startMs")
      const end = num(c.p.endMs, "endMs")
      if (end <= start) bad("endMs must be after startMs")
      return data.trimAudio(c.fileId, c.cellId, str(c.p.audioId, "audioId"), Math.round(start), Math.round(end))
    },
    "audio.voices": async (params) => data.voices(file(params)),
    "audio.assignVoice": async (params) => {
      const c = cell(params)
      const voiceId = c.p.voiceId === null || c.p.voiceId === undefined ? null : str(c.p.voiceId, "voiceId")
      return data.assignVoice(c.fileId, c.cellId, voiceId)
    },
    "audio.clone": async (params) => {
      const c = cell(params)
      return data.cloneVoice(c.fileId, c.cellId)
    },
    "source.actions": async (params) => {
      const c = cell(params)
      return data.sourceActions(c.fileId, c.cellId)
    },
    "source.commit": async (params) => {
      const c = cell(params)
      const html = c.p.html === undefined || c.p.html === null ? null : text(c.p.html, "html")
      return data.commitSource(c.fileId, c.cellId, text(c.p.value, "value"), html)
    },
    "source.setHidden": async (params) => {
      const c = cell(params)
      return data.setCellHidden(c.fileId, c.cellId, c.p.hidden === true)
    },
    "source.insert": async (params) => {
      const c = cell(params)
      if (c.p.side !== "above" && c.p.side !== "below") bad('side must be "above" or "below"')
      return data.insertCell(c.fileId, c.cellId, c.p.side)
    },
    "source.remove": async (params) => {
      const c = cell(params)
      return data.removeCell(c.fileId, c.cellId)
    },
    "source.retime": async (params) => {
      const c = cell(params)
      const start = num(c.p.startSec, "startSec")
      const end = num(c.p.endSec, "endSec")
      if (end <= start) bad("endSec must be after startSec")
      return data.retimeCell(c.fileId, c.cellId, start, end)
    },
    "ai.examples": async (params) => {
      const c = cell(params)
      return data.examples(c.fileId, c.cellId)
    },
    "ai.contextual": async (params) => data.contextualDrafts(file(params)),
    "ai.reviewContextual": async (params) => {
      const c = cell(params)
      return data.reviewContextual(c.fileId, c.cellId, str(c.p.draftId, "draftId"), c.p.accept === true)
    },
    "ai.smartEdits": async (params) => {
      const c = cell(params)
      return data.smartEdits(c.fileId, c.cellId)
    },
    "ai.smartEditFeedback": async (params) => {
      const c = cell(params)
      if (c.p.action !== "accept" && c.p.action !== "dismiss") bad('action must be "accept" or "dismiss"')
      return data.smartEditFeedback(c.fileId, c.cellId, str(c.p.id, "id"), c.p.action)
    },
    "terms.selection": async (params) => {
      const c = cell(params)
      return data.termSelection(c.fileId, c.cellId, selection(c.p.text))
    },
    "terms.view": async (params) => {
      const c = cell(params)
      return data.viewTerm(c.fileId, c.cellId, selection(c.p.text), rect(c.p.rect))
    },
    "terms.add": async (params) => {
      const c = cell(params)
      return data.addTerm(c.fileId, c.cellId, selection(c.p.text), rect(c.p.rect))
    },
    "agent.ask": async (params) => {
      const c = cell(params)
      return data.askAi(c.fileId, c.cellId, selection(c.p.text))
    },
  }
}

/** What the workspace implements (editor-services.ts `rev4`): the same
 *  methods, each also given the calling extension's provenance tag so its
 *  writes are attributed (`tool_origin`). */
export type ToolRev4Services = {
  [K in keyof ToolRev4HostData]: (...args: [...Parameters<ToolRev4HostData[K]>, ToolOrigin]) => ReturnType<ToolRev4HostData[K]>
}

const REV4_METHODS: readonly (keyof ToolRev4HostData)[] = [
  "audioTakes", "validateAudio", "voiceTake", "trimAudio", "voices", "assignVoice", "cloneVoice",
  "sourceActions", "commitSource", "setCellHidden", "insertCell", "removeCell", "retimeCell",
  "examples", "contextualDrafts", "reviewContextual", "smartEdits", "smartEditFeedback",
  "termSelection", "viewTerm", "addTerm", "askAi",
]

/** ToolRev4HostData over whichever services serve `fileId` (throws
 *  not_available off an editor mount), tagging writes with `origin`. */
export function rev4Delegates(servicesFor: (fileId: string) => ToolRev4Services, origin: ToolOrigin): ToolRev4HostData {
  const out: Record<string, unknown> = {}
  for (const name of REV4_METHODS) {
    out[name] = (fileId: string, ...rest: unknown[]) => {
      const fn = servicesFor(fileId)[name] as (...a: unknown[]) => Promise<unknown>
      return fn(fileId, ...rest, origin)
    }
  }
  return out as unknown as ToolRev4HostData
}
