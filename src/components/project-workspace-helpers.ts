// Pure helpers extracted from ProjectWorkspace so Fast Refresh can update
// the component without a full reload (component files must not export
// non-components).

import { ROLE } from "@/lib/frontier/roles"
import type { ContextualDraftsScope } from "@/lib/contextual/drafts-store"
import { btSeedsFromAlignmentSeeds, type BtSeed } from "@/lib/completion/bt-glosser"
import type { BacktranslationRecord } from "@/lib/completion/bt-record"
import type { CellSummary } from "@/hooks/useActiveCellStore"
import type { ProjectRecord } from "@/lib/parsers/types"

/**
 * Returns true iff the completion-settings save should actually patch
 * systemPrompt on the server. Guards against two failure modes:
 *   1. Empty-prompt clobber: buildCompletionSettings() materialises "" by
 *      default, so provider-only saves would erase the server prompt.
 *   2. Under-MAINTAINER write: sub-600 callers 403 server-side; skipping
 *      avoids IDB/server divergence (same floor as handleImported).
 */
export function shouldPatchSystemPrompt(
  systemPrompt: string | null | undefined,
  roleLevel: number,
): boolean {
  if (!systemPrompt || systemPrompt.trim().length === 0) return false
  return roleLevel >= ROLE.MAINTAINER
}

/**
 * Returns true iff the zero-file self-heal should fire a `/link/sync`
 * trigger for the current project. Only live-linked projects can be
 * self-healed this way (clone links never sync again after creation — the
 * QA-flagged gap there is closed at link time in the auth-worker route, not
 * here). Guards against re-firing for a project that already has files (the
 * common case, and the state right after a successful heal) and against
 * re-firing for the SAME project id more than once per mount (the caller
 * tracks `alreadyAttemptedProjectId` across renders via a ref).
 */
export function shouldSelfHealZeroFileLink(args: {
  projectId: string | null | undefined
  jwt: string | null | undefined
  sourceLinkMode: "clone" | "live" | null | undefined
  fileCount: number
  alreadyAttemptedProjectId: string | null
}): boolean {
  const { projectId, jwt, sourceLinkMode, fileCount, alreadyAttemptedProjectId } = args
  if (!projectId || !jwt) return false
  if (sourceLinkMode !== "live") return false
  if (fileCount > 0) return false
  if (alreadyAttemptedProjectId === projectId) return false
  return true
}

/**
 * A deterministic check run describes ONE file's cells. If the user switches
 * files while the (async) run is in flight, its result must not be committed —
 * it would clobber the now-active file's state with the prior file's findings.
 * Apply a result only when it still matches the currently-active file.
 */
export function shouldApplyCheckResult(
  resultFileId: string | null,
  activeFileId: string | null,
): boolean {
  return resultFileId != null && resultFileId === activeFileId
}

/** Sidebar Agent rail click: focus the workbench only while it is the
 *  active center surface. A leftover Agent tab in the strip (after
 *  minimize / switching to a file) must not steal the click — that is
 *  dock mode again. */
export function resolveSidebarAgentClick(
  workbenchActive: boolean,
): "activate-editor-tab" | "open-dock" {
  return workbenchActive ? "activate-editor-tab" : "open-dock"
}

/**
 * Reconcile Autopilot's lossy realtime mirrors whenever the project socket
 * opens, including reconnects on the same route. The captured draft scope is
 * a generation token, so both consumers independently discard late results
 * if navigation wins the race.
 */
export async function reconcileContextualAfterRealtimeOpen(args: {
  projectId: string
  currentFileId: string | null
  draftScope: ContextualDraftsScope | null
  attachRun: (projectId: string, fileId: string, targetLang?: string) => Promise<void>
  refreshDrafts: (scope: ContextualDraftsScope) => Promise<void>
}): Promise<void> {
  const { projectId, currentFileId, draftScope } = args
  if (
    !draftScope ||
    !currentFileId ||
    draftScope.projectId !== projectId ||
    draftScope.fileId !== currentFileId
  ) return
  await Promise.all([
    args.attachRun(projectId, currentFileId, draftScope.targetLang),
    args.refreshDrafts(draftScope),
  ])
}

/**
 * A target commit and contextual-draft reconciliation land atomically in the
 * sync projection. Re-read the durable proposal list for the open lane when
 * that applied-event echo reaches the exact editor scope, including for our
 * own writes. The echo is the first point at which the server-side projection
 * is known to be authoritative; an earlier client review request may have raced
 * it or failed independently.
 */
export async function reconcileContextualDraftsAfterAppliedEvent(args: {
  projectId: string
  currentFileId: string | null
  draftScope: ContextualDraftsScope | null
  event: {
    kind: string | undefined
    projectId: string
    fileId: string | null | undefined
  }
  refreshDrafts: (scope: ContextualDraftsScope) => Promise<void>
}): Promise<void> {
  const { draftScope, event } = args
  if (
    event.kind !== "target.cell.commit" ||
    event.projectId !== args.projectId ||
    !event.fileId ||
    event.fileId !== args.currentFileId ||
    !draftScope ||
    draftScope.projectId !== args.projectId ||
    draftScope.fileId !== event.fileId
  ) return
  await args.refreshDrafts(draftScope)
}

/**
 * What the outbox says happened to a track deletion, and therefore whether its
 * recordings may now be removed. (AQU-646, 2026-08-27)
 *
 * Deleting a track is two writes with two different authorities: removing its
 * takes is `cell.audio.remove` at contributor level, while removing the row is
 * `file.track.set` behind the project's `allowTrackEditing` setting. The worker
 * authorizes each event on its own and answers with a mixed accepted/rejected
 * list, so emitting both together let the server take the recordings and refuse
 * the row — and say nothing, because the flusher quarantines a 403 before the
 * `rejected` list that feeds `onRejected`.
 *
 * So the row goes first and this reads the outbox back to see whether it
 * landed. Reading the records rather than the flush's counters is deliberate:
 * the flusher sends the oldest file's slice, which need not be the one we
 * queued, and its `quarantined` count says nothing about WHICH events it
 * covered. A record that is GONE was accepted; one still present was refused
 * (`failed`) or never sent (`pending`).
 *
 * `proceed` is false for BOTH of those. An answer we never got is not
 * permission to delete somebody's recordings — the honest resting state is a
 * track that still exists, still holding them.
 */
export function trackDeleteGate(
  remaining: readonly { status: "pending" | "failed"; lastError: { reason: string } | null }[],
): { proceed: boolean; refused: boolean; reason: string | null } {
  if (remaining.length === 0) return { proceed: true, refused: false, reason: null }
  const refused = remaining.find((r) => r.status === "failed")
  return {
    proceed: false,
    refused: refused != null,
    reason: refused?.lastError?.reason ?? null,
  }
}

/**
 * AQU-207: assemble every glosser seed the workspace contributes, in one pure
 * place so the composition is testable without rendering ProjectWorkspace.
 *
 * Four sources feed the statistical BT, in ascending order of how explicitly
 * the user asked for them:
 *   - corrected BTs from the cache (2, or 5 when unpolished — a raw human edit)
 *   - termbase renderings (preferred 3 / admitted 1 / forbidden -3)
 *   - confirmed / invalidated interlinear alignments (±2 via
 *     `btSeedsFromAlignmentSeeds`)
 *
 * The alignment source was the one missing until AQU-207: those seeds were
 * persisted and fed back into `interlinear.ts`'s own model, so the panel's
 * suggestions sharpened, but the BT the user actually reads never moved.
 */
export function buildGlosserSeeds(args: {
  corpusCells: readonly CellSummary[]
  backtranslationCache: ReadonlyMap<string, BacktranslationRecord>
  terminology: ProjectRecord["terminology"] | undefined
  alignmentSeeds: ProjectRecord["alignmentSeeds"] | undefined
}): BtSeed[] {
  const { corpusCells, backtranslationCache, terminology, alignmentSeeds } = args
  const seeds: BtSeed[] = []

  // High-weight seeds from previous user-corrected BTs stored in the cache.
  // Corrected BTs (saved via onSaveBacktranslation) are re-fed as seeds so
  // future glosses reflect the reviewer's intent.
  const corpusByCellId = new Map(corpusCells.map((c) => [c.id, c]))
  for (const record of backtranslationCache.values()) {
    const cell = corpusByCellId.get(record.cellId)
    if (!cell?.translated) continue
    // A BT pinned to a superseded target event describes text that no longer
    // exists — seeding from it would teach the glosser a stale rendering.
    if (record.targetEventId && cell.targetEventId && record.targetEventId !== cell.targetEventId) {
      continue
    }
    seeds.push({
      source: record.btText,
      target: record.forText || cell.translated,
      weight: record.polished === false ? 5 : 2,
    })
  }

  // Seed from project termbase: active concepts feed preferred/admitted/forbidden
  // renderings into the glosser so terminology constraints propagate to BTs.
  for (const concept of terminology ?? []) {
    if (concept.status !== "active") continue
    for (const rendering of concept.renderings) {
      const weight =
        rendering.status === "preferred" ? 3 :
        rendering.status === "admitted" ? 1 :
        -3 // forbidden
      seeds.push({ source: concept.sourceTerm, target: rendering.rendering, weight })
    }
  }

  // AQU-207: alignments the user confirmed / invalidated in the interlinear
  // panel are seeds too — this is what makes a confirmation move the BT.
  seeds.push(...btSeedsFromAlignmentSeeds(alignmentSeeds ?? []))

  return seeds
}

/** AQU-1326: the deferral gate's state. `open` is what the secondary per-file
 *  hooks read; `file` and `sawLoad` exist only so the reducer can tell the
 *  three "not loading" situations apart. */
export interface PaintGate {
  /** The file this gate describes, so a switch re-closes it. */
  file: string | null
  /** True once a load for `file` has actually been observed in flight. */
  sawLoad: boolean
  /** True once the secondary per-file reads may start. */
  open: boolean
}

/**
 * AQU-1326: decides when the workspace's secondary per-file reads (validation
 * stats, comments, audio attachments, the sidebar progress rollup) may start.
 * They must wait for the editor's own first cell page, so the cell stream gets
 * the connection to itself on open.
 *
 * The subtlety this exists for: the cell store's `isLoading` starts FALSE and
 * only flips true once its fetch gets past an async cache read. So "not
 * loading" at mount is indistinguishable from "finished loading", and gating
 * on it directly opens the gate on the first commit — before the cell stream
 * has even been requested, which is the exact fan-out being prevented. A
 * finished load therefore only counts once a load was actually seen.
 *
 * The three releases that are NOT a first paint are all real and all needed:
 * no file open (nothing to wait behind), a failed load (no rows are coming),
 * and a load that finished with zero rows (an empty file must not strand these
 * hooks forever).
 */
export function nextPaintGate(
  prev: PaintGate,
  input: {
    fileId: string | null
    cellCount: number
    cellsError: boolean
    cellsLoading: boolean
  },
): PaintGate {
  const file = input.fileId
  const freshFile = prev.file !== file
  const sawLoad = (freshFile ? false : prev.sawLoad) || input.cellsLoading
  // On a file switch the cell count can still describe the PREVIOUS file for a
  // render, so it is not trusted until the gate has settled on this file. The
  // other two releases are trusted immediately: suppressing them on a fresh
  // file risks latching the gate shut, because nothing would necessarily
  // change again to re-run this.
  const open = !file
    ? true
    : input.cellsError
      || (sawLoad && !input.cellsLoading)
      || (!freshFile && input.cellCount > 0)
  if (!freshFile && prev.open === open && prev.sawLoad === sawLoad) return prev
  return { file, sawLoad, open }
}
