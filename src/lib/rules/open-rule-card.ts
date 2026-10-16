// AQU-1634: the violation rule card is a single app-wide surface — one entry in
// the bottom-right toast stack. "Which card is open" therefore cannot live in
// per-row state: every EditorRow kept its own `openRuleId`, so clicking a
// second row's underline left the first row's card mounted and stacked a
// second card on top. One module-level store means opening another underline
// replaces whatever card was open.
//
// Keyed by (cellId, ruleId, matchHash) because the toast id is derived from
// them, and a row only renders the card while the store says that row owns it.
// AQU-1740: the hash is which FINDING of the rule was clicked, so the card's
// waive accepts that match rather than the rule across the whole cell.

import { useSyncExternalStore } from "react"

export interface OpenRuleCard {
  cellId: string
  ruleId: string
  /** AQU-1740: the clicked finding, when the blot named one. Absent means the
   *  card acts on the rule as a whole (absence rules, keyboard entry points). */
  matchHash?: string
}

let openCard: OpenRuleCard | null = null
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): OpenRuleCard | null {
  return openCard
}

function emit(): void {
  for (const listener of [...listeners]) listener()
}

/** Open `ruleId`'s card for `cellId`, replacing any card already open. */
export function openRuleCard(cellId: string, ruleId: string, matchHash?: string): void {
  if (
    openCard?.cellId === cellId &&
    openCard.ruleId === ruleId &&
    openCard.matchHash === matchHash
  ) {
    return
  }
  openCard = { cellId, ruleId, ...(matchHash ? { matchHash } : {}) }
  emit()
}

/**
 * Close the open card. Passing `cellId` closes it only when that cell owns it,
 * so a row tearing down (virtualisation, lane switch, file change) cannot
 * close a card that has since moved to another row.
 */
export function closeRuleCard(cellId?: string): void {
  if (!openCard) return
  if (cellId !== undefined && openCard.cellId !== cellId) return
  openCard = null
  emit()
}

/** Test seam — drop any open card without notifying React. */
export function resetRuleCardForTests(): void {
  openCard = null
  listeners.clear()
}

/** The card this cell has open, or null when it belongs to another row. */
export function useOpenRuleCard(cellId: string): OpenRuleCard | null {
  const card = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return card?.cellId === cellId ? card : null
}
