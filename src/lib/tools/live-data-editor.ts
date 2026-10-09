/**
 * apiRev 3: the live half of the editor-parity bridge. An `editor` mount gets
 * the workspace's editor services (editor-services.ts) for its bound file;
 * every call about another file — or from a mount with no services — answers
 * "not available" instead of reaching across files.
 */

import { BridgeError } from "./host-bridge"
import type { ToolSettingsSection, ToolTypingParams, ToolEditorHostData } from "./host-handlers-editor"
import type { ToolCellPage, ToolCellView, ToolEdit, ToolValidateResult, ToolWriteResult } from "./host-handlers"
import { cellToToolView, pageFromStore, sectionsFromStore, termMatchesFor, type ToolEditorServices, type ToolViewExtras } from "./editor-services"
import type { ToolOrigin } from "../../../shared/tools/manifest"
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

/** How long a paged read waits for the shared store to reach a page before
 *  answering with what it has (the store keeps loading; nextCursor says so). */
const STORE_WAIT_MS = 20_000

export class LiveEditorData implements ToolEditorHostData {
  private readonly getServices: () => ToolEditorServices | undefined
  private readonly boundFile: () => string | undefined
  private readonly origin: ToolOrigin
  /** Per-cell store versions the extension has seen (drives cells.changed). */
  readonly seen = new Map<string, number>()

  constructor(opts: { services: () => ToolEditorServices | undefined; boundFile: () => string | undefined; origin: ToolOrigin }) {
    this.getServices = opts.services
    this.boundFile = opts.boundFile
    this.origin = opts.origin
  }

  /** The services, if this mount has them for `fileId`. */
  for(fileId: string): ToolEditorServices | null {
    const s = this.getServices()
    if (!s) return null
    const bound = this.boundFile()
    return bound && bound !== fileId ? null : s
  }

  private need(fileId: string): ToolEditorServices {
    const s = this.for(fileId)
    if (!s) throw new BridgeError("not_available", "only an editor extension mounted for this file can do that")
    return s
  }

  // ── Reads served from the workspace's store ──────────────────────────────

  private extras(s: ToolEditorServices): ToolViewExtras {
    return { ribbonFor: s.ribbonFor, structureFor: s.structureFor, lineNumbers: s.config.lineNumbers }
  }

  private remember(views: ToolCellView[], s: ToolEditorServices): ToolCellView[] {
    for (const v of views) this.seen.set(v.cellId, s.store.getCellVersion(v.cellId))
    return views
  }

  /** Resolve once the store holds `count` cells or has finished loading. */
  private async waitFor(fileId: string, count: number): Promise<ToolEditorServices> {
    const started = Date.now()
    for (;;) {
      const s = this.need(fileId)
      if (!s.storeLoading || s.store.getCellIds().length >= count || Date.now() - started > STORE_WAIT_MS) return s
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, 250)
        const unsub = s.store.subscribeAll(done)
        function done() {
          clearTimeout(timer)
          unsub()
          resolve()
        }
      })
    }
  }

  async page(fileId: string, cursor: string | null, limit: number): Promise<ToolCellPage> {
    const start = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0
    const s = await this.waitFor(fileId, start + limit)
    const page = pageFromStore(s.store, cursor, limit, s.storeLoading, this.extras(s))
    this.remember(page.cells, s)
    return page
  }

  async get(fileId: string, cellIds: string[]): Promise<ToolCellView[]> {
    const s = await this.waitFor(fileId, 1)
    return this.remember(s.store.getCellsByIds(cellIds).map((c) => cellToToolView(s.store, c, this.extras(s))), s)
  }

  async all(fileId: string): Promise<ToolCellView[]> {
    const s = await this.waitFor(fileId, Number.MAX_SAFE_INTEGER)
    return this.remember(s.store.getAllCellViews().map((c) => cellToToolView(s.store, c, this.extras(s))), s)
  }

  /** Cells the extension has read whose store version moved since. */
  changedSinceSeen(s: ToolEditorServices): string[] {
    const out: string[] = []
    for (const [cellId, version] of this.seen) {
      const now = s.store.getCellVersion(cellId)
      if (now !== version) {
        out.push(cellId)
        this.seen.set(cellId, now)
      }
    }
    return out
  }

  // ── Writes through the host's own commit / validation pipeline ───────────

  async commit(edits: ToolEdit[], sanitize: (html: string) => string): Promise<ToolWriteResult> {
    const committed: string[] = []
    const failed: ToolWriteResult["failed"] = []
    for (const edit of edits) {
      const s = this.need(edit.fileId)
      const cell = s.store.getCellView(edit.cellId)
      if (!cell) {
        failed.push({ cellId: edit.cellId, reason: "not_found" })
        continue
      }
      const valueHtml = edit.html !== undefined ? sanitize(edit.html) : edit.value
      if (cell.translated === edit.value && (edit.html === undefined || valueHtml === (cell.translatedHtml ?? ""))) {
        committed.push(edit.cellId)
        continue
      }
      try {
        await s.commitTarget(edit.cellId, { value: edit.value, valueHtml }, this.origin)
        committed.push(edit.cellId)
      } catch (err) {
        failed.push({ cellId: edit.cellId, reason: err instanceof Error ? err.message : String(err) })
      }
    }
    return { committed, failed }
  }

  async setValidation(items: { fileId: string; cellId: string }[], validated: boolean): Promise<ToolValidateResult> {
    const done: string[] = []
    const failed: ToolValidateResult["failed"] = []
    for (const item of items) {
      const s = this.need(item.fileId)
      const cell = s.store.getCellView(item.cellId)
      if (!cell?.targetEventId) {
        failed.push({ cellId: item.cellId, reason: cell ? "no_translation" : "not_found" })
        continue
      }
      if (await s.setValidation(item.cellId, validated, this.origin)) done.push(item.cellId)
      else failed.push({ cellId: item.cellId, reason: "not_allowed" })
    }
    return { validated: done, failed }
  }

  // ── apiRev 3 surfaces ────────────────────────────────────────────────────

  async editorConfig(fileId: string): Promise<ToolEditorConfig> {
    return this.need(fileId).config
  }

  async setLane(fileId: string, tag: string): Promise<boolean> {
    const s = this.need(fileId)
    if (!s.config.lanes.some((l) => l.tag === tag)) throw new BridgeError("invalid_params", `no lane "${tag}" in this project`)
    s.setLane(tag)
    return true
  }

  async setLens(lens: ToolLens): Promise<boolean> {
    const s = this.getServices()
    if (!s || !s.config.lenses.includes(lens)) return false
    s.setLens(lens)
    return true
  }

  async openSettings(section: ToolSettingsSection): Promise<boolean> {
    const s = this.getServices()
    if (!s) return false
    if (section === "lanes" && !s.config.canManageLanes) return false
    s.openSettings(section)
    return true
  }

  async sections(fileId: string): Promise<ToolSection[]> {
    const s = await this.waitFor(fileId, Number.MAX_SAFE_INTEGER)
    return sectionsFromStore(s.store)
  }

  async signals(fileId: string): Promise<ToolCellSignals> {
    return this.need(fileId).signals
  }

  async pericopes(fileId: string): Promise<ToolPericope[]> {
    return [...this.need(fileId).pericopes]
  }

  async settle(fileId: string, cellId: string): Promise<boolean> {
    this.need(fileId).settle(cellId)
    return true
  }

  async termMatches(fileId: string, cellIds: string[]): Promise<Record<string, ToolTermMatch[]>> {
    const s = this.need(fileId)
    return termMatchesFor(s.store, cellIds, s.concepts, s.termMatching)
  }

  async openTerm(conceptId: string): Promise<boolean> {
    const s = this.getServices()
    if (!s || !s.concepts.some((c) => c.id === conceptId)) return false
    s.openTerm(conceptId)
    return true
  }

  async draft(fileId: string, cellIds: string[], opts: { regenerate: boolean }): Promise<boolean> {
    const s = this.need(fileId)
    if (!s.config.ai.configured) throw new BridgeError("ai_not_configured", "AI drafting is not set up for this project")
    return s.draft(cellIds.filter((id) => s.store.getCellView(id)), opts)
  }

  async draftParagraph(fileId: string, cellId: string): Promise<boolean> {
    const s = this.need(fileId)
    if (!s.config.ai.configured) throw new BridgeError("ai_not_configured", "AI drafting is not set up for this project")
    return s.draftParagraph(cellId)
  }

  async listBacktranslations(fileId: string): Promise<Record<string, ToolBacktranslation>> {
    const s = this.need(fileId)
    const out: Record<string, ToolBacktranslation> = {}
    for (const [cellId, bt] of s.backtranslations) out[cellId] = bt
    return out
  }

  async runBacktranslation(fileId: string, cellId: string): Promise<boolean> {
    const s = this.need(fileId)
    if (!s.config.backtranslation.configured) throw new BridgeError("ai_not_configured", "back-translation is not set up for this project")
    return s.backtranslate(cellId)
  }

  async saveBacktranslation(fileId: string, cellId: string, text: string): Promise<boolean> {
    return this.need(fileId).saveBacktranslation(cellId, text)
  }

  async openHistory(fileId: string, cellId: string): Promise<boolean> {
    this.need(fileId).openHistory(cellId)
    return true
  }

  async openAttachments(fileId: string, cellId: string): Promise<boolean> {
    this.need(fileId).openAttachments(cellId)
    return true
  }

  async openRule(fileId: string, cellId: string, ruleId: string): Promise<boolean> {
    this.need(fileId).openRule(ruleId, cellId)
    return true
  }

  async listPeers(fileId: string): Promise<ToolPresencePeer[]> {
    return this.need(fileId).peers
  }

  async typing(fileId: string, cellId: string, selection: ToolTypingParams | null): Promise<boolean> {
    this.need(fileId).typing(cellId, selection)
    return true
  }

  async viewing(fileId: string, cellId: string | null): Promise<boolean> {
    this.need(fileId).viewing(cellId)
    return true
  }

  async recordAudio(fileId: string, cellId: string): Promise<boolean> {
    this.need(fileId).openRecorder(cellId)
    return true
  }

  async generateAudio(fileId: string, cellId: string): Promise<boolean> {
    return this.need(fileId).generateAudio(cellId)
  }

  async setSelection(fileId: string, cellIds: string[]): Promise<boolean> {
    const s = this.need(fileId)
    s.setSelection(cellIds.filter((id) => s.store.getCellView(id)))
    return true
  }

  async suggest(fileId: string, cellId: string, prefix: string): Promise<ToolSuggestion[]> {
    const s = this.for(fileId)
    return s ? s.suggest(cellId, prefix) : []
  }

  async suggestionFeedback(fileId: string, cellId: string, suggestionId: string, accepted: boolean): Promise<boolean> {
    const s = this.for(fileId)
    if (!s) return false
    s.suggestionFeedback(cellId, suggestionId, accepted)
    return true
  }
}
