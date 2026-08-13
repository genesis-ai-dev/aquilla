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
// goes through the caller's own outbox, exactly like a human edit. The winning
// target projection resolves accepted drafts atomically; rejection, which has
// no cell event, uses the review route. That asymmetry is the whole trust model:
// the robot may propose anywhere, and commits only where a human said so.

import { useSyncExternalStore } from "react"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextualDraftEntry {
  projectId: string
  fileId: string
  /** Empty string is the project-default lane. */
  targetLang: string
  runId: string | null
  draftId: string
  cellId: string
  text: string
  /** Passage label the draft came from ("LUK 4:1–4:12") — review-card context. */
  spanLabel: string
  /** Client-side arrival order; drives "newest first" review and the flash. */
  receivedAt: number
}

export interface ContextualDraftsSummary {
  projectId: string | null
  fileId: string | null
  targetLang: string
  /** Drafts awaiting a human decision. */
  pending: number
  /** Accepted in this session — the "you got 40 verses out of this" number. */
  acceptedThisSession: number
  rejectedThisSession: number
}

/**
 * Opaque attachment token captured before an authoritative fetch starts.
 * The generation prevents an A → B → A navigation from letting the
 * first A response overwrite the newer A session even though its ids match.
 */
export interface ContextualDraftsScope {
  projectId: string
  fileId: string
  targetLang: string
  generation: number
}

/** Frame shape mirroring auth-worker's ContextualDraftsFrame. */
export interface ContextualDraftsFrame {
  type: "contextual.drafts"
  runId: string
  fileId: string
  /** Required wire provenance. Must match the attached editor lane. */
  targetLang: string
  spanLabel: string
  drafts: { draftId: string; cellId: string; text: string }[]
  truncated?: boolean
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const EMPTY_DRAFTS: ReadonlyMap<string, ContextualDraftEntry> = new Map()
const IDLE_SUMMARY: ContextualDraftsSummary = {
  projectId: null,
  fileId: null,
  targetLang: "",
  pending: 0,
  acceptedThisSession: 0,
  rejectedThisSession: 0,
}

let _drafts: ReadonlyMap<string, ContextualDraftEntry> = EMPTY_DRAFTS
let _summary: ContextualDraftsSummary = IDLE_SUMMARY
let _scopeGeneration = 0
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

/** One cell's pending draft, scoped to the editor that will consume it. */
export function getContextualDraftFor(
  projectId: string,
  fileId: string,
  targetLang: string,
  cellId: string,
): ContextualDraftEntry | undefined {
  if (
    _summary.projectId !== projectId ||
    _summary.fileId !== fileId ||
    _summary.targetLang !== targetLang
  ) return undefined
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
export function applyContextualDraftsFrame(
  projectId: string,
  frame: ContextualDraftsFrame,
  currentRunId: string | null,
): { needsRefetch: boolean } {
  // Draft frames carry explicit lane provenance. A project/file/lane must
  // already be attached; never let an early or project-wide frame choose the
  // editor scope for us, and never apply a sibling language's proposals.
  if (
    _summary.projectId !== projectId ||
    _summary.fileId !== frame.fileId ||
    _summary.targetLang !== frame.targetLang
  ) return { needsRefetch: false }
  // Multiple historic runs may legitimately own REST-hydrated proposals, but
  // a live burst is transient output from exactly one current run. A delayed
  // burst from superseded run A must never overwrite run B's newer cell text.
  if (!currentRunId || frame.runId !== currentRunId) return { needsRefetch: true }
  // A truncated payload may have omitted rows or text that exceeded the live
  // envelope. Applying any part would expose a draft the user could accept as
  // though it were complete; leave the mirror untouched and fetch REST truth.
  if (frame.truncated === true) return { needsRefetch: true }
  if (frame.drafts.length === 0) return { needsRefetch: false }

  const next = new Map(_drafts)
  for (const d of frame.drafts) {
    next.set(d.cellId, {
      projectId,
      fileId: frame.fileId,
      targetLang: frame.targetLang,
      runId: frame.runId,
      draftId: d.draftId,
      cellId: d.cellId,
      text: d.text,
      spanLabel: frame.spanLabel,
      receivedAt: ++_seq,
    })
  }
  setDrafts(next)
  return { needsRefetch: false }
}

/**
 * Attach the mirror to the editor's exact project/file/lane. Scope changes
 * clear synchronously, before any snapshot request, so old text cannot flash
 * or be accepted while the next file is loading.
 */
export function attachContextualDrafts(
  projectId: string,
  fileId: string,
  targetLang = "",
): ContextualDraftsScope {
  const switching =
    _summary.projectId !== projectId ||
    _summary.fileId !== fileId ||
    _summary.targetLang !== targetLang
  if (switching) {
    _scopeGeneration += 1
    setSummary({
      projectId,
      fileId,
      targetLang,
      pending: 0,
      acceptedThisSession: 0,
      rejectedThisSession: 0,
    })
    setDrafts(EMPTY_DRAFTS)
  }
  return { projectId, fileId, targetLang, generation: _scopeGeneration }
}

function isCurrentScope(scope: ContextualDraftsScope): boolean {
  return scope.generation === _scopeGeneration &&
    scope.projectId === _summary.projectId &&
    scope.fileId === _summary.fileId &&
    scope.targetLang === _summary.targetLang
}

/**
 * Replace the mirror from an authoritative snapshot (file open, reconnect,
 * or a truncated burst). Session counters survive: they describe what the
 * PERSON did, not what the server currently holds.
 */
export function hydrateContextualDrafts(
  scope: ContextualDraftsScope,
  drafts: { draftId: string; runId?: string; cellId: string; text: string; spanLabel?: string }[],
): boolean {
  // The editor snapshot is lane-scoped. A stale response for another
  // project/file/lane cannot land in the open editor.
  if (!isCurrentScope(scope)) return false
  const next = new Map<string, ContextualDraftEntry>()
  for (const d of drafts) {
    next.set(d.cellId, {
      projectId: scope.projectId,
      fileId: scope.fileId,
      targetLang: scope.targetLang,
      runId: d.runId ?? null,
      draftId: d.draftId,
      cellId: d.cellId,
      text: d.text,
      spanLabel: d.spanLabel ?? "",
      receivedAt: ++_seq,
    })
  }
  setSummary({
    ..._summary,
    pending: next.size,
  })
  setDrafts(next)
  return true
}

/**
 * Drop an exact draft identity after its authoritative decision. Rejections
 * call this only after the server review route succeeds. Accepted drafts are
 * normally removed by the event.applied-triggered snapshot after the winning
 * target projection reconciles them; the `accepted` action remains available
 * for identity-safe consumers and session accounting, but is not an enqueue
 * acknowledgement.
 */
export function resolveContextualDraft(
  projectId: string,
  fileId: string,
  targetLang: string,
  cellId: string,
  expectedDraftId: string,
  action: "accepted" | "rejected",
): boolean {
  if (
    _summary.projectId !== projectId ||
    _summary.fileId !== fileId ||
    _summary.targetLang !== targetLang
  ) return false
  const existing = _drafts.get(cellId)
  if (
    !existing ||
    existing.projectId !== projectId ||
    existing.fileId !== fileId ||
    existing.targetLang !== targetLang ||
    existing.draftId !== expectedDraftId
  ) return false
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
  return true
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
  _scopeGeneration += 1
}
