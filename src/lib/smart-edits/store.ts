// Smart edits — per-cell suggestion cache for the editor.
//
// Suggestions carry plain-text offsets, so they are only valid for the exact
// text they were computed against. The store keeps that text beside them and
// `forCell` returns nothing once the cell's text has moved on: an underline in
// the wrong place is worse than none.
//
// `forCell` is a useSyncExternalStore snapshot: it returns the SAME array until
// that cell's suggestions change, so a passage answer re-renders the rows it
// is about and no others.

import type { SmartEditSuggestion } from "./client"

interface Entry {
  text: string
  suggestions: readonly SmartEditSuggestion[]
  /** `suggestions` minus the ones hidden on this device. */
  visible: SmartEditSuggestion[]
}

interface CellText {
  cellId: string
  target: string
}

export const NO_SUGGESTIONS: SmartEditSuggestion[] = []

export class SmartEditStore {
  private byCell = new Map<string, Entry>()
  /** Cell id → the text a request is already in flight for. */
  private asked = new Map<string, string>()
  private dismissed = new Set<string>()
  private listeners = new Set<() => void>()
  private version = 0

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getVersion = (): number => this.version

  /** The cells that have no answer for their current text and none on the
   *  way, marked as asked. Pair every call with `settle`. */
  claim<T extends CellText>(cells: readonly T[]): T[] {
    const stale = cells.filter(
      (c) => this.byCell.get(c.cellId)?.text !== c.target && this.asked.get(c.cellId) !== c.target,
    )
    for (const c of stale) this.asked.set(c.cellId, c.target)
    return stale
  }

  /** A request for `cells` ended. With `suggestions`, every cell gets an entry,
   *  even an empty one; without (the request was abandoned), they may be asked
   *  about again. */
  settle(cells: readonly CellText[], suggestions?: readonly SmartEditSuggestion[]): void {
    for (const c of cells) if (this.asked.get(c.cellId) === c.target) this.asked.delete(c.cellId)
    if (!suggestions) return
    const byCell = new Map<string, SmartEditSuggestion[]>()
    for (const s of suggestions) {
      const list = byCell.get(s.cellId)
      if (list) list.push(s)
      else byCell.set(s.cellId, [s])
    }
    for (const c of cells) this.put(c.cellId, c.target, byCell.get(c.cellId) ?? NO_SUGGESTIONS)
    this.bump()
  }

  /** Add on-request (LLM) suggestions for a cell's current text, replacing any
   *  earlier ones for the same span. */
  addForCell(cellId: string, text: string, suggestions: readonly SmartEditSuggestion[]): void {
    const entry = this.byCell.get(cellId)
    const kept = entry && entry.text === text ? entry.suggestions : []
    const ids = new Set(suggestions.map(suggestionId))
    this.put(cellId, text, [...kept.filter((s) => !ids.has(suggestionId(s))), ...suggestions])
    this.bump()
  }

  forCell(cellId: string, text: string): SmartEditSuggestion[] {
    const entry = this.byCell.get(cellId)
    return entry && entry.text === text ? entry.visible : NO_SUGGESTIONS
  }

  /** Hide locally at once (accepted or dismissed) — the server learns separately. */
  hide(s: SmartEditSuggestion): void {
    this.dismissed.add(suggestionId(s))
    const entry = this.byCell.get(s.cellId)
    if (entry) this.put(s.cellId, entry.text, entry.suggestions)
    this.bump()
  }

  private put(cellId: string, text: string, suggestions: readonly SmartEditSuggestion[]): void {
    const visible = suggestions.filter((s) => !this.dismissed.has(suggestionId(s)))
    this.byCell.set(cellId, { text, suggestions, visible: visible.length ? visible : NO_SUGGESTIONS })
  }

  private bump(): void {
    this.version++
    for (const l of this.listeners) l()
  }
}

export function suggestionId(s: Pick<SmartEditSuggestion, "cellId" | "start" | "end" | "newNorm">): string {
  return `${s.cellId}:${s.start}:${s.end}:${s.newNorm}`
}
