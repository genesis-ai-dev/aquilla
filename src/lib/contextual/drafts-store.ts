// Live autopilot drafts — the store that makes the run's OUTPUT visible.
//
// Before this, a contextual run staged verified translations into Postgres and
// the editor showed a progress bar. The work was real and entirely invisible;
// the only way to see it was a REST endpoint with no callers. This store is
// the missing half: drafts stream in over the project WebSocket and land in
// the cells they belong to, where the user is already looking.
//
// Shape follows the house idiom (run-store.ts, batch-completion.ts): a module
// pub-sub read through useSyncExternalStore, with the SERVER as the source of
// truth and this as a mirror. Two stores, deliberately:
//
//   - `drafts`  changes on every arriving frame (high churn, cell-scoped)
//   - `summary` changes only when the counts move (drives chrome that would
//     otherwise re-render on every single draft)
//
// A draft here is a PROPOSAL. Nothing in this module writes to a cell — accept
// goes through the caller's own outbox, exactly like a human edit, and only
// then reports the review to the server. That asymmetry is the whole trust
// model: the robot may propose anywhere, and commits only where a human said so.

import { useSyncExternalStore } from "react"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextualDraftEntry {
  draftId: string
  cellId: string
  text: string
  /** Passage label the draft came from ("LUK 4:1–4:12") — review-card context. */
  spanLabel: string
  /** Client-side arrival order; drives "newest first" review and the flash. */
  receivedAt: number
}

export interface ContextualDraftsSummary {
  fileId: string | null
  /** Drafts awaiting a human decision. */
  pending: number
  /** Accepted in this session — the "you got 40 verses out of this" number. */
  acceptedThisSession: number
  rejectedThisSession: number
}

/** Frame shape mirroring auth-worker's ContextualDraftsFrame. */
export interface ContextualDraftsFrame {
  type: "contextual.drafts"
  runId: string
  fileId: string
  spanLabel: string
  drafts: { draftId: string; cellId: string; text: string }[]
  truncated?: boolean
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const EMPTY_DRAFTS: ReadonlyMap<string, ContextualDraftEntry> = new Map()
const IDLE_SUMMARY: ContextualDraftsSummary = {
  fileId: null,
  pending: 0,
  acceptedThisSession: 0,
  rejectedThisSession: 0,
}

let _drafts: ReadonlyMap<string, ContextualDraftEntry> = EMPTY_DRAFTS
let _summary: ContextualDraftsSummary = IDLE_SUMMARY
/** Monotonic arrival counter — `Date.now()` ties at frame granularity, and a
 *  wave delivers several spans in the same millisecond. */
let _seq = 0

const _draftListeners = new Set<() => void>()
const _summaryListeners = new Set<() => void>()

function setDrafts(next: ReadonlyMap<string, ContextualDraftEntry>): void {
  _drafts = next
  for (const l of _draftListeners) l()
  const pending = next.size
  if (pending !== _summary.pending) setSummary({ ..._summary, pending })
}

function setSummary(next: ContextualDraftsSummary): void {
  _summary = next
  for (const l of _summaryListeners) l()
}

export function getContextualDrafts(): ReadonlyMap<string, ContextualDraftEntry> {
  return _drafts
}

export function getContextualDraftsSummary(): ContextualDraftsSummary {
  return _summary
}

function subscribeDrafts(l: () => void): () => void {
  _draftListeners.add(l)
  return () => { _draftListeners.delete(l) }
}

function subscribeSummary(l: () => void): () => void {
  _summaryListeners.add(l)
  return () => { _summaryListeners.delete(l) }
}

export function useContextualDrafts(): ReadonlyMap<string, ContextualDraftEntry> {
  return useSyncExternalStore(subscribeDrafts, getContextualDrafts, () => EMPTY_DRAFTS)
}

export function useContextualDraftsSummary(): ContextualDraftsSummary {
  return useSyncExternalStore(subscribeSummary, getContextualDraftsSummary, () => IDLE_SUMMARY)
}

/** One cell's pending draft, or undefined. Cheap enough to call per row. */
export function getContextualDraftFor(cellId: string): ContextualDraftEntry | undefined {
  return _drafts.get(cellId)
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

/**
 * Apply a `contextual.drafts` frame. Frames for another file are dropped: the
 * store mirrors the OPEN file only, and the editor has nowhere to put a draft
 * for a document that isn't on screen. A file switch re-hydrates from the
 * snapshot, so nothing is lost by ignoring them.
 *
 * `truncated` means the wave staged more than one frame could carry — the
 * caller refetches the authoritative list rather than showing a partial burst
 * as if it were everything.
 */
export function applyContextualDraftsFrame(frame: ContextualDraftsFrame): { needsRefetch: boolean } {
  if (_summary.fileId !== null && frame.fileId !== _summary.fileId) return { needsRefetch: false }
  if (frame.drafts.length === 0) return { needsRefetch: frame.truncated === true }

  const next = new Map(_drafts)
  for (const d of frame.drafts) {
    next.set(d.cellId, {
      draftId: d.draftId,
      cellId: d.cellId,
      text: d.text,
      spanLabel: frame.spanLabel,
      receivedAt: ++_seq,
    })
  }
  setDrafts(next)
  return { needsRefetch: frame.truncated === true }
}

/**
 * Replace the mirror from an authoritative snapshot (file open, reconnect,
 * or a truncated burst). Session counters survive: they describe what the
 * PERSON did, not what the server currently holds.
 */
export function hydrateContextualDrafts(
  fileId: string,
  drafts: { draftId: string; cellId: string; text: string; spanLabel?: string }[],
): void {
  const next = new Map<string, ContextualDraftEntry>()
  for (const d of drafts) {
    next.set(d.cellId, {
      draftId: d.draftId,
      cellId: d.cellId,
      text: d.text,
      spanLabel: d.spanLabel ?? "",
      receivedAt: ++_seq,
    })
  }
  const switching = _summary.fileId !== fileId
  setSummary({
    fileId,
    pending: next.size,
    acceptedThisSession: switching ? 0 : _summary.acceptedThisSession,
    rejectedThisSession: switching ? 0 : _summary.rejectedThisSession,
  })
  setDrafts(next)
}

/**
 * Drop a draft the user decided on. Optimistic by design — the server review
 * call is a report, not a gate, so the cell must clear the moment the user
 * clicks. A failed report leaves a stale `proposed` row that the next
 * hydrate reconciles; showing the draft again mid-decision would be worse.
 */
export function resolveContextualDraft(cellId: string, action: "accepted" | "rejected"): void {
  const existing = _drafts.get(cellId)
  if (!existing) return
  const next = new Map(_drafts)
  next.delete(cellId)
  setSummary({
    ..._summary,
    pending: next.size,
    acceptedThisSession:
      _summary.acceptedThisSession + (action === "accepted" ? 1 : 0),
    rejectedThisSession:
      _summary.rejectedThisSession + (action === "rejected" ? 1 : 0),
  })
  setDrafts(next)
}

/** Every pending draft, newest first — the review queue's order. */
export function listPendingDrafts(): ContextualDraftEntry[] {
  return [..._drafts.values()].sort((a, b) => b.receivedAt - a.receivedAt)
}

/** Test-only: full reset including session counters. */
export function resetContextualDraftsStore(): void {
  _drafts = EMPTY_DRAFTS
  _summary = IDLE_SUMMARY
  _seq = 0
}
