/**
 * The live ToolHostData: what a running tool actually reads and writes.
 *
 * Reads go to the sync-worker on demand (AD-3 thin client). Writes are the
 * ordinary typed emitters → IndexedDB outbox → POST /events path, chained on
 * each cell's live head (the server's head CAS still decides), and stamped
 * with `tool_origin` provenance. A tool never supplies a parent id: the host
 * resolves it from its own read, so a tool cannot aim a write at a stale head.
 */

import { fetchAllFileCells, fetchCellsByIds, fetchFileCells, fetchProjectFiles } from "@/lib/sync/cells-read"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { fetchConcepts } from "@/lib/sync/concepts-read"
import { fetchProjectSettings } from "@/lib/sync/project-settings"
import { FRONTIER_CHAT_URL } from "@/lib/completion/completion-service"
import { emitCellUnvalidate, emitCellValidate, emitTargetCellCommits, type CellCommitInput } from "@/lib/sync/events-emit"
import { fetchFileAudioAttachments } from "@/lib/sync/cell-audio-read"
import { slotSelections } from "@/lib/sync/cell-audio-read-types"
import { getCellAudioStreamUrl, parseFrontierAudioUrl } from "@/lib/audio/upload"
import { sanitizeSourceDisplayHtml } from "@/lib/richtext/editor-content"
import { resolveTargetCommitParent } from "@/lib/sync/target-commit-parent"
import type { ToolOrigin, ToolScope } from "../../../shared/tools/manifest"
import type { ToolEditorServices } from "./editor-services"
import { LiveEditorData } from "./live-data-editor"
import { rev4Delegates, type ToolRev4HostData } from "./host-handlers-rev4"
import { uiStrings, type UiStrings } from "./ui-strings"
import type { ToolSettingsSection, ToolTypingParams } from "./host-handlers-editor"
import type { ToolLens } from "../../../shared/tools/editor-api"
import type {
  HostKey,
  ToolAudioEntry,
  ToolCellPage,
  ToolCellView,
  ToolEdit,
  ToolFileView,
  ToolHostData,
  ToolPresence,
  ToolTermView,
  ToolValidateResult,
  ToolWriteResult,
} from "./host-handlers"

/**
 * Workspace services a mounted extension can reach (apiRev 2). Supplied by the
 * surface that mounts the frame — the editor mount gets the workspace's live
 * focus locks and comment feed; other mounts get none, and the bridge answers
 * those calls with empty results. Read through a getter so the latest values
 * apply without re-creating the bridge.
 */
export interface ToolHostServices {
  /** Other people's focus locks: lock key (cellId, or cellId@lane:x) → user. */
  lockHolders?: ReadonlyMap<string, string>
  claimCell?: (cellId: string) => void
  releaseCell?: (cellId: string) => void
  /** Open (unresolved) root comment threads per cellId. */
  commentCounts?: ReadonlyMap<string, number>
  openComments?: (cellId: string) => void
  /** The file this mount is bound to (claims/comments outside it are refused). */
  fileId?: string
  /** apiRev 3: the workspace's editor pipeline for `fileId` (editor mounts). */
  editor?: ToolEditorServices
}

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
  /** Persistent message for the user (aquilla.tell). */
  tell: (message: string) => void
  grantedScopes: () => ToolScope[]
  requestScope: (scope: ToolScope) => Promise<boolean>
  /** Per-tool, per-user storage namespace. */
  storageKey: string
  /** apiRev 2: workspace services (presence, comments) for this mount. */
  services?: () => ToolHostServices
  /** apiRev 2: replay an allowlisted host shortcut (host-keys.ts). */
  hostKey?: (key: HostKey) => boolean
  /** apiRev 3: the user's UI locale (for ui.strings). */
  locale?: () => string
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
        sourceHtml: s.valueHtml ? sanitizeSourceDisplayHtml(s.valueHtml) : null,
        targetHtml: t?.valueHtml ? sanitizeSourceDisplayHtml(t.valueHtml) : null,
        type: s.type ?? null,
        lastEditor: t?.lastEditor ?? null,
        lastEditAt: t?.lastEditAt ?? null,
        aiDrafted: t?.aiDrafted === true,
      },
      targetEventId: t?.eventId || null,
      sourceEventId: s.eventId || null,
      laneId: t?.laneId ?? laneId,
      targetLang: lane,
    })
  }
  return out
}

// apiRev 4 methods are delegated wholesale (rev4Delegates, constructor).
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- the rev-4 delegates are assigned in the constructor
export interface LiveToolData extends ToolRev4HostData {}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- see above
export class LiveToolData implements ToolHostData {
  private readonly opts: LiveToolDataOptions
  private readonly cache = new Map<string, Map<string, CachedCell>>()
  /** Files this tool has read through this data source. */
  readonly watchedFiles = new Set<string>()
  private defaultLane: Promise<{ tag: string; id: string | null }> | null = null

  /** apiRev 3: editor parity surfaces over the workspace's services. */
  readonly editor: LiveEditorData

  constructor(opts: LiveToolDataOptions) {
    this.opts = opts
    this.editor = new LiveEditorData({
      services: () => this.services().editor,
      boundFile: () => this.services().fileId,
      origin: opts.toolOrigin,
    })
    Object.assign(this, rev4Delegates((fileId) => this.editor.rev4(fileId), opts.toolOrigin))
  }

  /** Start the lane lookup and the file's sync token while the frame boots,
   *  so the extension's first read is one request, not three in a row. */
  warm(fileId: string): void {
    void this.resolveLane("")
    void this.opts.tokenFor(this.opts.projectId, fileId).catch(() => null)
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

  /** Cells whose cached head may be behind the server (after cells.changed). */
  private readonly stale = new Map<string, Set<string>>()

  invalidate(fileId: string): void {
    this.cache.delete(fileId)
    this.stale.delete(fileId)
  }

  /** apiRev 2: mark just these cells stale (a remote edit to one verse must
   *  not cost the next write a whole-book re-read). Empty = whole file. */
  invalidateCells(fileId: string, cellIds: readonly string[]): void {
    if (cellIds.length === 0) return this.invalidate(fileId)
    if (!this.cache.has(fileId)) return
    const set = this.stale.get(fileId) ?? new Set<string>()
    for (const id of cellIds) set.add(id)
    this.stale.set(fileId, set)
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
    this.stale.delete(fileId)
    this.watchedFiles.add(fileId)
    return paired
  }

  private mergeCache(fileId: string, paired: Map<string, CachedCell>): void {
    const existing = this.cache.get(fileId)
    if (!existing) {
      this.cache.set(fileId, new Map(paired))
    } else {
      for (const [id, c] of paired) existing.set(id, c)
    }
    this.watchedFiles.add(fileId)
  }

  /** apiRev 2: one server page (complete source/target groups per cell). */
  async pageCells(fileId: string, lane: string, cursor: string | null, limit: number): Promise<ToolCellPage> {
    // Editor mounts read the workspace's own store: one read of the file.
    if (!lane && this.editor.for(fileId)) return this.editor.page(fileId, cursor, limit)
    const resolved = await this.resolveLane(lane)
    const page = await fetchFileCells(
      this.opts.projectId,
      fileId,
      { paired: true, limit, ...(cursor ? { cursor } : {}), ...(resolved.tag ? { lane: resolved.tag } : {}) },
      await this.token(fileId),
    )
    if (page.completeRows !== true) {
      // An older sync-worker cannot keep a cell's rows on one page: fall back
      // to one complete read so no page ever shows half a cell.
      const all = await this.loadFile(fileId, lane)
      return { cells: [...all.values()].map((c) => c.view), nextCursor: null, total: all.size }
    }
    if (!cursor) this.cache.delete(fileId)
    const paired = pairRows(page.cells, resolved.tag, resolved.id)
    this.mergeCache(fileId, paired)
    const stale = this.stale.get(fileId)
    if (stale) for (const id of paired.keys()) stale.delete(id)
    return { cells: [...paired.values()].map((c) => c.view), nextCursor: page.nextCursor ?? null, total: null }
  }

  /** apiRev 2: re-read specific cells (after cells.changed) instead of the file. */
  async getCells(fileId: string, cellIds: string[], lane: string): Promise<ToolCellView[]> {
    if (cellIds.length === 0) return []
    if (!lane && this.editor.for(fileId)) return this.editor.get(fileId, cellIds)
    const resolved = await this.resolveLane(lane)
    const rows = await fetchCellsByIds(this.opts.projectId, fileId, cellIds, await this.token(fileId), resolved.tag || undefined)
    const paired = pairRows(rows, resolved.tag, resolved.id)
    this.mergeCache(fileId, paired)
    const stale = this.stale.get(fileId)
    if (stale) for (const id of paired.keys()) stale.delete(id)
    const wanted = new Set(cellIds)
    return [...paired.values()].filter((c) => wanted.has(c.view.cellId)).map((c) => c.view)
  }

  async listCells(fileId: string, lane: string): Promise<ToolCellView[]> {
    if (!lane && this.editor.for(fileId)) return this.editor.all(fileId)
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
    const stale = this.stale.get(fileId)
    if (stale?.has(cellId) && this.cache.has(fileId)) {
      stale.delete(cellId)
      await this.getCells(fileId, [cellId], "")
    }
    const cached = this.cache.get(fileId) ?? (await this.loadFile(fileId, ""))
    return cached.get(cellId)
  }

  async commit(edits: ToolEdit[]): Promise<ToolWriteResult> {
    if (edits.length > 0 && edits.every((e) => this.editor.for(e.fileId))) {
      return this.editor.commit(edits, sanitizeSourceDisplayHtml)
    }
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
      const html = edit.html !== undefined ? sanitizeSourceDisplayHtml(edit.html) : undefined
      if (cell.view.target === edit.value && (html === undefined || html === (cell.view.targetHtml ?? ""))) {
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
        ...(html !== undefined ? { valueHtml: html } : {}),
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
        touched[i].view = {
          ...touched[i].view,
          target: inputs[i].value,
          targetHtml: inputs[i].valueHtml ?? null,
          validated: false,
          aiDrafted: false,
          lastEditor: this.opts.author,
        }
        committed.push(inputs[i].cellId)
      })
      this.opts.flush()
    }
    return { committed, failed }
  }

  async validate(items: { fileId: string; cellId: string }[]): Promise<ToolValidateResult> {
    if (items.length > 0 && items.every((i) => this.editor.for(i.fileId))) return this.editor.setValidation(items, true)
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

  async unvalidate(items: { fileId: string; cellId: string }[]): Promise<ToolValidateResult> {
    if (items.length > 0 && items.every((i) => this.editor.for(i.fileId))) return this.editor.setValidation(items, false)
    const validated: string[] = []
    const failed: ToolValidateResult["failed"] = []
    for (const item of items) {
      const cell = await this.cellFor(item.fileId, item.cellId)
      if (!cell?.targetEventId) {
        failed.push({ cellId: item.cellId, reason: cell ? "no_translation" : "not_found" })
        continue
      }
      await emitCellUnvalidate({
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
      cell.view = { ...cell.view, validated: false }
      validated.push(item.cellId)
    }
    if (validated.length > 0) this.opts.flush()
    return { validated, failed }
  }

  private services(): ToolHostServices {
    return this.opts.services?.() ?? {}
  }

  /** Services bound to one file refuse calls about another file. */
  private boundTo(fileId: string): boolean {
    const bound = this.services().fileId
    return !bound || bound === fileId
  }

  async listPresence(fileId: string): Promise<ToolPresence> {
    const holders = this.services().lockHolders
    if (!holders || !this.boundTo(fileId)) return {}
    const out: ToolPresence = {}
    for (const [key, username] of holders) {
      // Lane-qualified lock keys (focusLockKey) carry "@lane:"; the cell id
      // is the part before it.
      out[key.split("@lane:")[0]] = { username }
    }
    return out
  }

  async claimCell(fileId: string, cellId: string): Promise<boolean> {
    const claim = this.services().claimCell
    if (!claim || !this.boundTo(fileId)) return false
    claim(cellId)
    return true
  }

  async releaseCell(fileId: string, cellId: string): Promise<boolean> {
    const release = this.services().releaseCell
    if (!release || !this.boundTo(fileId)) return false
    release(cellId)
    return true
  }

  async commentCounts(fileId: string): Promise<Record<string, number>> {
    const counts = this.services().commentCounts
    if (!counts || !this.boundTo(fileId)) return {}
    const cells = this.cache.get(fileId)
    const out: Record<string, number> = {}
    for (const [cellId, n] of counts) if (n > 0 && (!cells || cells.has(cellId))) out[cellId] = n
    return out
  }

  async openComments(fileId: string, cellId: string): Promise<boolean> {
    const open = this.services().openComments
    if (!open || !this.boundTo(fileId)) return false
    open(cellId)
    return true
  }

  private audioCache = new Map<string, Promise<Map<string, { audioId: string; ext: string; durationMs: number | null }>>>()
  private playing: HTMLAudioElement | null = null

  private loadAudio(fileId: string): Promise<Map<string, { audioId: string; ext: string; durationMs: number | null }>> {
    let p = this.audioCache.get(fileId)
    if (!p) {
      p = (async () => {
        const lane = await this.resolveLane("")
        const res = await fetchFileAudioAttachments(this.opts.projectId, fileId, await this.token(fileId), lane.tag)
        const out = new Map<string, { audioId: string; ext: string; durationMs: number | null }>()
        for (const [cellId, entry] of Object.entries(res.cells ?? {})) {
          const selected = Object.values(slotSelections(entry))
          const att = selected.map((id) => entry.attachments[id]).find(Boolean) ?? Object.values(entry.attachments)[0]
          const parsed = att ? parseFrontierAudioUrl(att.url) : null
          if (att && parsed) out.set(cellId, { ...parsed, durationMs: att.durationMs ?? null })
        }
        return out
      })()
      this.audioCache.set(fileId, p)
      p.catch(() => this.audioCache.delete(fileId))
    }
    return p
  }

  async listAudio(fileId: string): Promise<Record<string, ToolAudioEntry>> {
    this.audioCache.delete(fileId)
    const audio = await this.loadAudio(fileId)
    const out: Record<string, ToolAudioEntry> = {}
    for (const [cellId, a] of audio) out[cellId] = { hasAudio: true, durationMs: a.durationMs }
    return out
  }

  /** Playback happens in the HOST: the frame has no network (CSP), so it
   *  could not load the media even with a URL — and never gets one. */
  async playAudio(fileId: string, cellId: string): Promise<boolean> {
    const a = (await this.loadAudio(fileId)).get(cellId)
    if (!a) return false
    const url = await getCellAudioStreamUrl({
      projectId: this.opts.projectId,
      fileId,
      audioId: a.audioId,
      ext: a.ext,
      getSyncToken: this.opts.tokenFor,
    })
    if (!url) return false
    await this.stopAudio()
    const el = new Audio(url)
    this.playing = el
    await el.play()
    return true
  }

  async stopAudio(): Promise<boolean> {
    if (!this.playing) return false
    this.playing.pause()
    this.playing = null
    return true
  }

  async uiStrings(keys: string[]): Promise<UiStrings> {
    return uiStrings(this.opts.locale?.() ?? "en", keys)
  }

  async hostKey(key: HostKey): Promise<boolean> {
    return this.opts.hostKey?.(key) ?? false
  }

  // ── apiRev 3: editor parity (live-data-editor.ts) ────────────────────────
  editorConfig = (fileId: string) => this.editor.editorConfig(fileId)
  setLane = (fileId: string, tag: string) => this.editor.setLane(fileId, tag)
  setLens = (lens: ToolLens) => this.editor.setLens(lens)
  openSettings = (section: ToolSettingsSection) => this.editor.openSettings(section)
  sections = (fileId: string) => this.editor.sections(fileId)
  signals = (fileId: string) => this.editor.signals(fileId)
  pericopes = (fileId: string) => this.editor.pericopes(fileId)
  settle = (fileId: string, cellId: string) => this.editor.settle(fileId, cellId)
  termMatches = (fileId: string, cellIds: string[]) => this.editor.termMatches(fileId, cellIds)
  openTerm = (conceptId: string) => this.editor.openTerm(conceptId)
  draft = (fileId: string, cellIds: string[], opts: { regenerate: boolean }) => this.editor.draft(fileId, cellIds, opts)
  draftParagraph = (fileId: string, cellId: string) => this.editor.draftParagraph(fileId, cellId)
  listBacktranslations = (fileId: string) => this.editor.listBacktranslations(fileId)
  runBacktranslation = (fileId: string, cellId: string) => this.editor.runBacktranslation(fileId, cellId)
  saveBacktranslation = (fileId: string, cellId: string, text: string) => this.editor.saveBacktranslation(fileId, cellId, text)
  openHistory = (fileId: string, cellId: string) => this.editor.openHistory(fileId, cellId)
  openAttachments = (fileId: string, cellId: string) => this.editor.openAttachments(fileId, cellId)
  openRule = (fileId: string, cellId: string, ruleId: string) => this.editor.openRule(fileId, cellId, ruleId)
  listPeers = (fileId: string) => this.editor.listPeers(fileId)
  typing = (fileId: string, cellId: string, selection: ToolTypingParams | null) => this.editor.typing(fileId, cellId, selection)
  viewing = (fileId: string, cellId: string | null) => this.editor.viewing(fileId, cellId)
  visible = (fileId: string, cellIds: string[]) => this.editor.visible(fileId, cellIds)
  recordAudio = (fileId: string, cellId: string) => this.editor.recordAudio(fileId, cellId)
  generateAudio = (fileId: string, cellId: string) => this.editor.generateAudio(fileId, cellId)
  setSelection = (fileId: string, cellIds: string[]) => this.editor.setSelection(fileId, cellIds)
  suggest = (fileId: string, cellId: string, prefix: string) => this.editor.suggest(fileId, cellId, prefix)
  suggestionFeedback = (fileId: string, cellId: string, suggestionId: string, accepted: boolean) =>
    this.editor.suggestionFeedback(fileId, cellId, suggestionId, accepted)

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

  tell(message: string): void {
    this.opts.tell(message)
  }

  /** aquilla.ai.generate: the app's own chat proxy, billed/guarded like any
   *  in-app AI call (the extension never sees a key). */
  async generate(input: { prompt: string; system: string; maxTokens: number }): Promise<{ text: string }> {
    const messages = [
      ...(input.system ? [{ role: "system", content: input.system }] : []),
      { role: "user", content: input.prompt },
    ]
    const res = await fetch(FRONTIER_CHAT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.opts.sessionJwt}` },
      body: JSON.stringify({ model: "default", messages, max_tokens: input.maxTokens, temperature: 0.3, stream: false, projectId: this.opts.projectId }),
    })
    if (!res.ok) throw new Error(`AI request failed (HTTP ${res.status})`)
    const body = (await res.json()) as { choices?: { message?: { content?: string | null } }[] }
    return { text: body.choices?.[0]?.message?.content ?? "" }
  }

  grantedScopes(): ToolScope[] {
    return this.opts.grantedScopes()
  }

  requestScope(scope: ToolScope): Promise<boolean> {
    return this.opts.requestScope(scope)
  }
}
