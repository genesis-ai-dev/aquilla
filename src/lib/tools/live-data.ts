/**
 * The live ToolHostData: what a running tool actually reads and writes.
 *
 * Reads go to the sync-worker on demand (AD-3 thin client). Writes are the
 * ordinary typed emitters → IndexedDB outbox → POST /events path, chained on
 * each cell's live head (the server's head CAS still decides), and stamped
 * with `tool_origin` provenance. A tool never supplies a parent id: the host
 * resolves it from its own read, so a tool cannot aim a write at a stale head.
 */

import { fetchAllFileCells, fetchProjectFiles } from "@/lib/sync/cells-read"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { fetchConcepts } from "@/lib/sync/concepts-read"
import { fetchProjectSettings } from "@/lib/sync/project-settings"
import { emitCellValidate, emitTargetCellCommits, type CellCommitInput } from "@/lib/sync/events-emit"
import { resolveTargetCommitParent } from "@/lib/sync/target-commit-parent"
import type { ToolOrigin, ToolScope } from "../../../shared/tools/manifest"
import type {
  ToolCellView,
  ToolEdit,
  ToolFileView,
  ToolHostData,
  ToolTermView,
  ToolValidateResult,
  ToolWriteResult,
} from "./host-handlers"

export type SyncTokenFor = (projectId: string, fileId: string) => Promise<string | null>

interface CachedCell {
  view: ToolCellView
  targetEventId: string | null
  sourceEventId: string | null
  laneId: string | null
  targetLang: string
}

export interface LiveToolDataOptions {
  projectId: string
  /** Session JWT (auth-worker) — used to resolve the project's lanes. */
  sessionJwt: string
  author: string
  toolOrigin: ToolOrigin
  tokenFor: SyncTokenFor
  /** Kick the outbox so writes land promptly (OutboxContext.flushNow). */
  flush: () => void
  notify: (message: string) => void
  grantedScopes: () => ToolScope[]
  requestScope: (scope: ToolScope) => Promise<boolean>
  /** Per-tool, per-user storage namespace. */
  storageKey: string
}

const CHAPTER_RE = /^(.+?)\s+(\d+)[:.]/

export function chapterOf(ref: string | null): string | null {
  if (!ref) return null
  const m = CHAPTER_RE.exec(ref)
  return m ? `${m[1]} ${m[2]}` : null
}

/** Pair source/target rows (one lane) into the tool's cell view. Exported for tests. */
export function pairRows(rows: CellRow[], lane: string, laneId: string | null = null): Map<string, CachedCell> {
  const order: string[] = []
  const source = new Map<string, CellRow>()
  const target = new Map<string, CellRow>()
  for (const r of rows) {
    if (r.side === "source") {
      if (!source.has(r.cellId)) order.push(r.cellId)
      source.set(r.cellId, r)
    } else if ((r.targetLang ?? "") === lane) {
      target.set(r.cellId, r)
    }
  }
  const out = new Map<string, CachedCell>()
  for (const cellId of order) {
    const s = source.get(cellId)
    if (!s || s.hidden) continue
    const t = target.get(cellId)
    const ref = s.canonicalRef ?? t?.canonicalRef ?? null
    out.set(cellId, {
      view: {
        cellId,
        ref,
        source: s.value,
        target: t?.value ?? "",
        validated: t?.validated ?? false,
        chapter: chapterOf(ref),
      },
      targetEventId: t?.eventId || null,
      sourceEventId: s.eventId || null,
      laneId: t?.laneId ?? laneId,
      targetLang: lane,
    })
  }
  return out
}

export class LiveToolData implements ToolHostData {
  private readonly opts: LiveToolDataOptions
  private readonly cache = new Map<string, Map<string, CachedCell>>()
  /** Files this tool has listed — the scope of its cells.changed pushes. */
  readonly watchedFiles = new Set<string>()
  private defaultLane: Promise<{ tag: string; id: string | null }> | null = null

  constructor(opts: LiveToolDataOptions) {
    this.opts = opts
  }

  private async token(fileId: string): Promise<string> {
    const t = await this.opts.tokenFor(this.opts.projectId, fileId)
    if (!t) throw new Error("no sync token for this project")
    return t
  }

  /** The project's first live target lane — what a tool's "" lane means. */
  private resolveLane(lane: string): Promise<{ tag: string; id: string | null }> {
    if (lane) return Promise.resolve({ tag: lane, id: null })
    if (!this.defaultLane) {
      this.defaultLane = fetchProjectSettings(this.opts.sessionJwt, this.opts.projectId)
        .then((settings) => {
          const target = (settings?.lanes ?? [])
            .filter((l) => l.role === "target" && !l.archivedAt)
            .sort((a, b) => a.position - b.position)[0]
          return { tag: target?.legacyTag ?? "", id: target?.id ?? null }
        })
        .catch(() => ({ tag: "", id: null }))
    }
    return this.defaultLane
  }

  invalidate(fileId: string): void {
    this.cache.delete(fileId)
  }

  async listFiles(): Promise<ToolFileView[]> {
    const files = await fetchProjectFiles(this.opts.projectId, await this.token("any"))
    return files
      .filter((f) => f.role !== "audio-cues" && !f.deletedAt)
      .map((f) => ({ fileId: f.fileId, name: f.name, cellCount: f.cellCount }))
  }

  private async loadFile(fileId: string, lane: string): Promise<Map<string, CachedCell>> {
    const resolved = await this.resolveLane(lane)
    const rows = await fetchAllFileCells(this.opts.projectId, fileId, await this.token(fileId), undefined, resolved.tag || undefined)
    const paired = pairRows(rows, resolved.tag, resolved.id)
    this.cache.set(fileId, paired)
    this.watchedFiles.add(fileId)
    return paired
  }

  async listCells(fileId: string, lane: string): Promise<ToolCellView[]> {
    const paired = await this.loadFile(fileId, lane)
    return [...paired.values()].map((c) => c.view)
  }

  async listTerms(): Promise<ToolTermView[]> {
    const concepts = await fetchConcepts(this.opts.projectId, await this.token("any"))
    return concepts.map((c) => ({
      id: c.id,
      term: c.sourceTerm,
      renderings: c.renderings.map((r) => ({ rendering: r.rendering, status: r.status })),
      notes: c.notes ?? null,
    }))
  }

  private async cellFor(fileId: string, cellId: string): Promise<CachedCell | undefined> {
    const cached = this.cache.get(fileId) ?? (await this.loadFile(fileId, ""))
    return cached.get(cellId)
  }

  async commit(edits: ToolEdit[]): Promise<ToolWriteResult> {
    const failed: ToolWriteResult["failed"] = []
    const committed: string[] = []
    const inputs: CellCommitInput[] = []
    const touched: CachedCell[] = []
    for (const edit of edits) {
      const cell = await this.cellFor(edit.fileId, edit.cellId)
      if (!cell) {
        failed.push({ cellId: edit.cellId, reason: "not_found" })
        continue
      }
      if (cell.view.target === edit.value) {
        committed.push(edit.cellId)
        continue
      }
      inputs.push({
        projectId: this.opts.projectId,
        fileId: edit.fileId,
        cellId: edit.cellId,
        parentId: resolveTargetCommitParent({ targetEventId: cell.targetEventId, sourceEventId: cell.sourceEventId }),
        sourceEventId: cell.sourceEventId,
        ...(cell.targetLang ? { targetLang: cell.targetLang } : {}),
        ...(cell.laneId ? { laneId: cell.laneId } : {}),
        value: edit.value,
        author: this.opts.author,
        toolOrigin: this.opts.toolOrigin,
      })
      touched.push(cell)
    }
    if (inputs.length > 0) {
      const ids = await emitTargetCellCommits(inputs)
      // Optimistic head: a second commit before the server echoes must chain
      // on the event we just minted, not the stale read.
      ids.forEach((id, i) => {
        touched[i].targetEventId = id
        touched[i].view = { ...touched[i].view, target: inputs[i].value, validated: false }
        committed.push(inputs[i].cellId)
      })
      this.opts.flush()
    }
    return { committed, failed }
  }

  async validate(items: { fileId: string; cellId: string }[]): Promise<ToolValidateResult> {
    const validated: string[] = []
    const failed: ToolValidateResult["failed"] = []
    for (const item of items) {
      const cell = await this.cellFor(item.fileId, item.cellId)
      if (!cell?.targetEventId) {
        failed.push({ cellId: item.cellId, reason: cell ? "no_translation" : "not_found" })
        continue
      }
      await emitCellValidate({
        projectId: this.opts.projectId,
        fileId: item.fileId,
        cellId: item.cellId,
        editEventId: cell.targetEventId,
        ...(cell.targetLang ? { targetLang: cell.targetLang } : {}),
        ...(cell.laneId ? { laneId: cell.laneId } : {}),
        author: this.opts.author,
        surface: "batch",
        toolOrigin: this.opts.toolOrigin,
      })
      cell.view = { ...cell.view, validated: true }
      validated.push(item.cellId)
    }
    if (validated.length > 0) this.opts.flush()
    return { validated, failed }
  }

  private readStore(): Record<string, unknown> {
    try {
      const raw = localStorage.getItem(this.opts.storageKey)
      const parsed: unknown = raw ? JSON.parse(raw) : {}
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }

  private writeStore(next: Record<string, unknown>): void {
    try {
      localStorage.setItem(this.opts.storageKey, JSON.stringify(next))
    } catch {
      // Storage is a convenience; a full/blocked store must not break the tool.
    }
  }

  async storageGet(key: string): Promise<unknown> {
    return this.readStore()[key] ?? null
  }

  async storageSet(key: string, value: unknown): Promise<void> {
    this.writeStore({ ...this.readStore(), [key]: value })
  }

  async storageRemove(key: string): Promise<void> {
    const next = this.readStore()
    delete next[key]
    this.writeStore(next)
  }

  notify(message: string): void {
    this.opts.notify(message)
  }

  grantedScopes(): ToolScope[] {
    return this.opts.grantedScopes()
  }

  requestScope(scope: ToolScope): Promise<boolean> {
    return this.opts.requestScope(scope)
  }
}
