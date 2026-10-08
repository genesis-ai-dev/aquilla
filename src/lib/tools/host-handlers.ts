/**
 * Bridge method handlers: param validation over a ToolHostData source. The
 * live source (live-data.ts) reads/writes the real project; the smoke render
 * (smoke.ts) passes a stub. Keep in step with the builder's system prompt
 * (auth-worker/src/lib/tools/build-prompt.ts).
 */

import { BridgeError, type BridgeHandler } from "./host-bridge"
import { isToolScope, type ToolScope } from "../../../shared/tools/manifest"

export interface ToolFileView {
  fileId: string
  name: string
  cellCount: number
}

export interface ToolCellView {
  cellId: string
  ref: string | null
  source: string
  target: string
  validated: boolean
  chapter: string | null
}

export interface ToolTermView {
  id: string
  term: string
  renderings: { rendering: string; status: string }[]
  notes: string | null
}

export interface ToolEdit {
  fileId: string
  cellId: string
  value: string
}

export interface ToolWriteResult {
  committed: string[]
  failed: { cellId: string; reason: string }[]
}

export interface ToolValidateResult {
  validated: string[]
  failed: { cellId: string; reason: string }[]
}

export interface ToolHostData {
  listFiles: () => Promise<ToolFileView[]>
  listCells: (fileId: string, lane: string) => Promise<ToolCellView[]>
  listTerms: () => Promise<ToolTermView[]>
  commit: (edits: ToolEdit[]) => Promise<ToolWriteResult>
  validate: (items: { fileId: string; cellId: string }[]) => Promise<ToolValidateResult>
  storageGet: (key: string) => Promise<unknown>
  storageSet: (key: string, value: unknown) => Promise<void>
  storageRemove: (key: string) => Promise<void>
  notify: (message: string) => void
  /** One completion through the app's own AI proxy, as the user. */
  generate: (input: { prompt: string; system: string; maxTokens: number }) => Promise<{ text: string }>
  /** A message for the user that stays until dismissed (unlike notify). */
  tell: (message: string) => void
  grantedScopes: () => ToolScope[]
  /** Explicit permission request (aquilla.permissions.request). */
  requestScope: (scope: ToolScope) => Promise<boolean>
}

export const MAX_EDITS_PER_CALL = 2000
export const MAX_VALUE_CHARS = 20_000
export const MAX_STORAGE_VALUE_CHARS = 64_000

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

function key(params: unknown): string {
  if (!isRecord(params)) bad("params must be an object")
  return str(params.key, "key", 200)
}

function cellRefs(list: unknown, name: string): { fileId: string; cellId: string }[] {
  if (!Array.isArray(list)) bad(`${name} must be an array`)
  if (list.length > MAX_EDITS_PER_CALL) bad(`at most ${MAX_EDITS_PER_CALL} ${name} per call`)
  return list.map((item, i) => {
    if (!isRecord(item)) bad(`${name}[${i}] must be an object`)
    return { fileId: str(item.fileId, `${name}[${i}].fileId`), cellId: str(item.cellId, `${name}[${i}].cellId`) }
  })
}

export function parseEdits(params: unknown): ToolEdit[] {
  if (!isRecord(params)) bad("params must be an object")
  const refs = cellRefs(params.edits, "edits")
  const raw = params.edits as unknown[]
  return refs.map((ref, i) => {
    const value = (raw[i] as Record<string, unknown>).value
    if (typeof value !== "string") bad(`edits[${i}].value must be a string`)
    if (value.length > MAX_VALUE_CHARS) bad(`edits[${i}].value exceeds ${MAX_VALUE_CHARS} characters`)
    return { ...ref, value }
  })
}

export function createToolHandlers(data: ToolHostData): Record<string, BridgeHandler> {
  return {
    "files.list": async () => data.listFiles(),
    "cells.list": async (params) => {
      if (!isRecord(params)) bad("params must be an object")
      const lane = typeof params.lane === "string" ? params.lane : ""
      return data.listCells(str(params.fileId, "fileId"), lane)
    },
    "terms.list": async () => data.listTerms(),
    "cells.commit": async (params) => data.commit(parseEdits(params)),
    "cells.validate": async (params) => {
      if (!isRecord(params)) bad("params must be an object")
      return data.validate(cellRefs(params.items, "items"))
    },
    "storage.get": async (params) => data.storageGet(key(params)),
    "storage.set": async (params) => {
      const k = key(params)
      const value = (params as Record<string, unknown>).value
      const json = JSON.stringify(value ?? null)
      if (json.length > MAX_STORAGE_VALUE_CHARS) bad(`storage value exceeds ${MAX_STORAGE_VALUE_CHARS} characters`)
      await data.storageSet(k, JSON.parse(json))
      return true
    },
    "storage.remove": async (params) => {
      await data.storageRemove(key(params))
      return true
    },
    "permissions.list": async () => data.grantedScopes(),
    "permissions.request": async (params) => {
      if (!isRecord(params) || !isToolScope(params.scope)) bad("scope must be a known scope")
      return data.requestScope(params.scope)
    },
    "ai.generate": async (params) => {
      if (!isRecord(params) || typeof params.prompt !== "string" || !params.prompt.trim()) bad("prompt must be a non-empty string")
      if (params.prompt.length > 20_000) bad("prompt exceeds 20000 characters")
      const system = typeof params.system === "string" ? params.system.slice(0, 5000) : ""
      const maxTokens = typeof params.maxTokens === "number" && params.maxTokens > 0 ? Math.min(params.maxTokens, 2000) : 800
      return data.generate({ prompt: params.prompt, system, maxTokens })
    },
    tell: async (params) => {
      if (!isRecord(params) || typeof params.message !== "string") bad("message must be a string")
      data.tell(params.message.slice(0, 1000))
      return true
    },
    "ui.notify": async (params) => {
      if (!isRecord(params) || typeof params.message !== "string") bad("message must be a string")
      data.notify(params.message.slice(0, 300))
      return true
    },
  }
}
