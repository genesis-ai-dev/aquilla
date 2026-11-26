/**
 * External store bridging Smart Extensions and Aquilla's real native
 * `EditorTable` without stuffing transient state into `ProjectWorkspace.tsx`.
 *
 * One instance lives in `ToolsMountProvider` per project workspace:
 *   - Active cell: native `EditorTable` publishes the focused cell; mounted
 *     side panels subscribe and receive live `editor.activeCell` pushes.
 *   - Reveal: native `EditorTable` registers its scroll/focus handle so
 *     extensions can call `aquilla.editor.reveal(fileId, cellId)`.
 *   - Annotations & columns: extensions call `aquilla.editor.annotate(...)`
 *     to publish row badges, inline span highlights/fixes, and read-only
 *     column cells; native `EditorTable` subscribes via `useSyncExternalStore`.
 */

import type {
  ExtensionAnnotateInput,
  ExtensionCellBadge,
  ExtensionCellSpan,
  ExtensionColumnCell,
  NativeActiveCell,
} from "../../../shared/tools/native-editor"

export interface ResolvedBadge extends ExtensionCellBadge {
  toolId: string
  toolName: string
  layer: string
}

export interface ResolvedSpan extends ExtensionCellSpan {
  toolId: string
  toolName: string
  layer: string
}

export interface ResolvedCellAnnotations {
  badges: ResolvedBadge[]
  spans: ResolvedSpan[]
}

export const EMPTY_CELL_ANNOTATIONS: ResolvedCellAnnotations = Object.freeze({ badges: [], spans: [] })

export type RevealHandler = (fileId: string, cellId: string, focus: boolean) => boolean

type Listener = () => void

interface ToolLayerEntry {
  toolId: string
  toolName: string
  fileId: string
  layer: string
  cells: ExtensionAnnotateInput["cells"]
}

export class NativeEditorStore {
  private activeCell: NativeActiveCell | null = null
  private activeListeners = new Set<Listener>()
  private revealHandler: RevealHandler | null = null

  /** Keyed by `${toolId}\u0000${fileId}\u0000${layer}` */
  private layers = new Map<string, ToolLayerEntry>()
  /** Memoized per `${fileId}\u0000${cellId}` snapshot, invalidated on mutate. */
  private cellCache = new Map<string, ResolvedCellAnnotations>()
  private version = 0
  private listeners = new Set<Listener>()
  /** Column keys (`${toolId}:${columnId}`) that received data this session. */
  private populatedColumns = new Set<string>()

  // ── Active cell ──────────────────────────────────────────────────────────
  getActiveCell = (): NativeActiveCell | null => this.activeCell

  setActiveCell = (next: NativeActiveCell | null): void => {
    const prev = this.activeCell
    if (
      prev === next ||
      (prev &&
        next &&
        prev.fileId === next.fileId &&
        prev.cellId === next.cellId &&
        prev.ref === next.ref &&
        prev.source === next.source &&
        prev.target === next.target)
    ) {
      return
    }
    this.activeCell = next
    for (const fn of this.activeListeners) fn()
  }

  subscribeActiveCell = (fn: Listener): (() => void) => {
    this.activeListeners.add(fn)
    return () => {
      this.activeListeners.delete(fn)
    }
  }

  // ── Reveal in native editor ──────────────────────────────────────────────
  registerReveal = (handler: RevealHandler | null): void => {
    this.revealHandler = handler
  }

  reveal = (fileId: string, cellId: string, focus = true): boolean => {
    return this.revealHandler ? this.revealHandler(fileId, cellId, focus) : false
  }

  // ── Annotations & extension column values ────────────────────────────────
  getVersion = (): number => this.version

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private bump(): void {
    this.version++
    this.cellCache.clear()
    for (const fn of this.listeners) fn()
  }

  annotate = (toolId: string, toolName: string, input: ExtensionAnnotateInput): number => {
    const key = `${toolId}\u0000${input.fileId}\u0000${input.layer}`
    const count = Object.keys(input.cells).length
    if (count === 0) {
      if (this.layers.delete(key)) this.bump()
      return 0
    }
    this.layers.set(key, { toolId, toolName, fileId: input.fileId, layer: input.layer, cells: input.cells })
    for (const cell of Object.values(input.cells)) {
      if (cell.columns) {
        for (const colId of Object.keys(cell.columns)) this.populatedColumns.add(`${toolId}:${colId}`)
      }
    }
    this.bump()
    return count
  }

  clearAnnotations = (toolId: string, fileId?: string | null, layer?: string | null): boolean => {
    let changed = false
    for (const [k, entry] of this.layers) {
      if (entry.toolId !== toolId) continue
      if (fileId && entry.fileId !== fileId) continue
      if (layer && entry.layer !== layer) continue
      this.layers.delete(k)
      changed = true
    }
    if (changed) this.bump()
    return changed
  }

  hasPopulatedColumn = (toolId: string, columnId: string): boolean => {
    return this.populatedColumns.has(`${toolId}:${columnId}`)
  }

  getCellAnnotations = (fileId: string, cellId: string): ResolvedCellAnnotations => {
    const cacheKey = `${fileId}\u0000${cellId}`
    const cached = this.cellCache.get(cacheKey)
    if (cached) return cached
    let badges: ResolvedBadge[] | null = null
    let spans: ResolvedSpan[] | null = null
    for (const entry of this.layers.values()) {
      if (entry.fileId !== fileId) continue
      const ann = entry.cells[cellId]
      if (!ann) continue
      if (ann.badges?.length) {
        badges ??= []
        for (const b of ann.badges) badges.push({ ...b, toolId: entry.toolId, toolName: entry.toolName, layer: entry.layer })
      }
      if (ann.spans?.length) {
        spans ??= []
        for (const s of ann.spans) spans.push({ ...s, toolId: entry.toolId, toolName: entry.toolName, layer: entry.layer })
      }
    }
    const result = !badges && !spans ? EMPTY_CELL_ANNOTATIONS : { badges: badges ?? [], spans: spans ?? [] }
    this.cellCache.set(cacheKey, result)
    return result
  }

  getColumnCell = (fileId: string, toolId: string, columnId: string, cellId: string): ExtensionColumnCell | null => {
    // Latest layer written by this tool that contains a value for this column & cell wins.
    let found: ExtensionColumnCell | null = null
    for (const entry of this.layers.values()) {
      if (entry.fileId !== fileId || entry.toolId !== toolId) continue
      const val = entry.cells[cellId]?.columns?.[columnId]
      if (val) found = val
    }
    return found
  }
}

/** Per-user, per-project extension column visibility overrides (`"shown"` | `"hidden"`). */
export type ExtensionColumnPref = "shown" | "hidden"

export function extensionColumnsPrefKey(username: string, projectId: string): string {
  return `aquilla.extensions.columns.v1:${username}:${projectId}`
}

export function readExtensionColumnPrefs(username: string, projectId: string, storage: Storage | null = safeStorage()): Record<string, ExtensionColumnPref> {
  if (!storage) return {}
  try {
    const raw = storage.getItem(extensionColumnsPrefKey(username, projectId))
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return {}
    const out: Record<string, ExtensionColumnPref> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === "shown" || v === "hidden") out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

export function writeExtensionColumnPrefs(username: string, projectId: string, prefs: Record<string, ExtensionColumnPref>, storage: Storage | null = safeStorage()): void {
  try {
    storage?.setItem(extensionColumnsPrefKey(username, projectId), JSON.stringify(prefs))
  } catch {
    // private mode / quota — in-memory prefs still apply
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage
  } catch {
    return null
  }
}
