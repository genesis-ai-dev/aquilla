// Pure helpers extracted from ProjectWorkspace so Fast Refresh can update
// the component without a full reload (component files must not export
// non-components).

import { ROLE } from "@/lib/frontier/roles"
import type { ContextualDraftsScope } from "@/lib/contextual/drafts-store"

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

/** Sidebar Agent rail click. While the workbench is the active center
 *  surface the rail item shows as active, and clicking it LEAVES the
 *  workbench (back to the editor) — the rail's toggle idiom, and the fix for
 *  "I can't click the agent thing in the sidebar" (2026-08-28 transcript):
 *  re-navigating to the URL you are already on reads as a dead control. A
 *  leftover Agent tab in the strip (after minimize / switching to a file)
 *  must not steal the click — that is dock mode again. */
export function resolveSidebarAgentClick(
  workbenchActive: boolean,
): "close-workbench" | "open-dock" {
  return workbenchActive ? "close-workbench" : "open-dock"
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
