// Smart edits — per-cell suggestion cache for the editor.
//
// Suggestions carry plain-text offsets, so they are only valid for the exact
// text they were computed against. The store keeps that text beside them and
// `forCell` returns nothing once the cell's text has moved on: an underline in
// the wrong place is worse than none.

import type { SmartEditSuggestion } from "./client"

interface Entry {
  text: string
  suggestions: SmartEditSuggestion[]
}

export class SmartEditStore {
  private byCell = new Map<string, Entry>()
  private dismissed = new Set<string>()
  private listeners = new Set<() => void>()
  private version = 0

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getVersion = (): number => this.version

  /** True when every cell already has suggestions for exactly this text. */
  isFresh(cells: readonly { cellId: string; target: string }[]): boolean {
    return cells.every((c) => this.byCell.get(c.cellId)?.text === c.target)
  }

  /** Record a passage response: every cell sent gets an entry, even an empty one. */
  setPassage(cells: readonly { cellId: string; target: string }[], suggestions: readonly SmartEditSuggestion[]): void {
    for (const c of cells) {
      this.byCell.set(c.cellId, { text: c.target, suggestions: suggestions.filter((s) => s.cellId === c.cellId) })
    }
    this.bump()
  }

  /** Add on-request (LLM) suggestions for a cell's current text, replacing any
   *  earlier ones for the same span. */
  addForCell(cellId: string, text: string, suggestions: readonly SmartEditSuggestion[]): void {
    const entry = this.byCell.get(cellId)
    const kept = entry && entry.text === text ? entry.suggestions : []
    const ids = new Set(suggestions.map(suggestionId))
    this.byCell.set(cellId, { text, suggestions: [...kept.filter((s) => !ids.has(suggestionId(s))), ...suggestions] })
    this.bump()
  }

  forCell(cellId: string, text: string): SmartEditSuggestion[] {
    const entry = this.byCell.get(cellId)
    if (!entry || entry.text !== text) return []
    return entry.suggestions.filter((s) => !this.dismissed.has(suggestionId(s)))
  }

  /** Hide locally at once (accepted or dismissed) — the server learns separately. */
  hide(s: SmartEditSuggestion): void {
    this.dismissed.add(suggestionId(s))
    this.bump()
  }

  private bump(): void {
    this.version++
    for (const l of this.listeners) l()
  }
}

export function suggestionId(s: Pick<SmartEditSuggestion, "cellId" | "start" | "end" | "newNorm">): string {
  return `${s.cellId}:${s.start}:${s.end}:${s.newNorm}`
}
