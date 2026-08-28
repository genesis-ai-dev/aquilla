/**
 * team-conversations.ts — shared data source for the Team surfaces
 * (v2.2 three-column layout, 2026-08-28): the sidebar's threads list and the
 * active conversation both need the same runs + open decisions, so one
 * refcounted per-project poller feeds every mounted consumer instead of each
 * component polling the transport on its own.
 *
 * Also owns the pure row-builder for the conversations list, so the dock and
 * any other roster render identical rows.
 */

import { useCallback, useSyncExternalStore } from "react"
import type { TFunction } from "@/lib/i18n/I18nProvider"
import type { AgentRunUi } from "./run-state"
import {
  fetchContextualDecisions,
  fetchContextualRuns,
  type ContextualDecisionsPage,
  type ContextualRunRecord,
} from "@/lib/contextual/transport"
import { humanPassageLabel } from "../../../shared/span-label"
import {
  QUESTIONS_CONVERSATION,
  TEAM_CHAT_CONVERSATION,
  runThreadId,
} from "./team-channel"

const POLL_MS = 4_000
const RUN_PAGE_LIMIT = 12

export interface TeamConversationsState {
  runs: ContextualRunRecord[] | null
  decisions: ContextualDecisionsPage | null
  loadFailed: boolean
}

interface ProjectPoller {
  state: TeamConversationsState
  listeners: Set<() => void>
  timer: number | null
  refs: number
  loading: boolean
}

const EMPTY_STATE: TeamConversationsState = { runs: null, decisions: null, loadFailed: false }

const pollers = new Map<string, ProjectPoller>()

function emit(poller: ProjectPoller, next: TeamConversationsState): void {
  poller.state = next
  for (const listener of poller.listeners) listener()
}

async function load(projectId: string, poller: ProjectPoller): Promise<void> {
  if (poller.loading) return
  poller.loading = true
  try {
    const [runsPage, decisionsPage] = await Promise.all([
      fetchContextualRuns(projectId, { limit: RUN_PAGE_LIMIT }),
      fetchContextualDecisions(projectId),
    ])
    emit(poller, { runs: runsPage.runs, decisions: decisionsPage, loadFailed: false })
  } catch {
    emit(poller, { ...poller.state, loadFailed: true })
  } finally {
    poller.loading = false
  }
}

function acquire(projectId: string): ProjectPoller {
  let poller = pollers.get(projectId)
  if (!poller) {
    poller = {
      state: { runs: null, decisions: null, loadFailed: false },
      listeners: new Set(),
      timer: null,
      refs: 0,
      loading: false,
    }
    pollers.set(projectId, poller)
  }
  poller.refs += 1
  if (poller.timer === null) {
    void load(projectId, poller)
    poller.timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return
      void load(projectId, poller!)
    }, POLL_MS)
  }
  return poller
}

function release(projectId: string, poller: ProjectPoller): void {
  poller.refs -= 1
  if (poller.refs > 0) return
  if (poller.timer !== null) window.clearInterval(poller.timer)
  pollers.delete(projectId)
}

/** Subscribe to the shared runs/decisions poll for a project. */
export function useTeamConversations(projectId: string): TeamConversationsState & {
  retry: () => void
} {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const poller = acquire(projectId)
      poller.listeners.add(onStoreChange)
      // First subscriber may attach after acquire() already resolved a load;
      // the snapshot read below covers that, no manual notify needed.
      return () => {
        poller.listeners.delete(onStoreChange)
        release(projectId, poller)
      }
    },
    [projectId],
  )
  const state = useSyncExternalStore(
    subscribe,
    () => pollers.get(projectId)?.state ?? EMPTY_STATE,
  )
  const retry = useCallback(() => {
    const poller = pollers.get(projectId)
    if (poller) void load(projectId, poller)
  }, [projectId])
  return { ...state, retry }
}

/** Test-only: drop all pollers between tests. */
export function resetTeamConversationsForTesting(): void {
  for (const poller of pollers.values()) {
    if (poller.timer !== null) window.clearInterval(poller.timer)
  }
  pollers.clear()
}

// ── Conversation rows (shared by the sidebar list and any roster) ───────────

export interface TeamConversationRow {
  id: string
  title: string
  preview: string
  /** ISO timestamp of the latest activity; null hides the time slot. */
  at: string | null
  /** Count needing the human (drafts to review, open questions). 0 hides it. */
  badge: number
  /** Someone is actively working/streaming in this conversation. */
  live: boolean
  /** Pinned rows (Team chat) render as their own block with a pin glyph. */
  pinned?: boolean
}

export function isRunWorkingStatus(status: string): boolean {
  return status === "running" || status === "pausing"
}

/** The latest line of the shared chat session, for the Team chat row. */
export function teamChatPreview(chatRuns: readonly AgentRunUi[], t: TFunction): string {
  const last = chatRuns.at(-1)
  if (!last) return t("agent.team.teamChatPreviewEmpty")
  for (let i = last.items.length - 1; i >= 0; i--) {
    const item = last.items[i]
    if (item.kind === "text" && item.text.trim()) return item.text.trim()
  }
  return last.prompt
}

export function buildConversationRows(args: {
  chatRuns: readonly AgentRunUi[]
  isStreaming: boolean
  runs: readonly ContextualRunRecord[]
  openCount: number
  firstQuestionReason: string | null
  runTitle: (run: ContextualRunRecord) => string
  runStatusLabel: (run: ContextualRunRecord) => string
  t: TFunction
}): TeamConversationRow[] {
  const rows: TeamConversationRow[] = [
    {
      id: TEAM_CHAT_CONVERSATION,
      title: args.t("agent.team.teamChat"),
      preview: teamChatPreview(args.chatRuns, args.t),
      at: null,
      badge: 0,
      live: args.isStreaming,
      pinned: true,
    },
  ]
  if (args.openCount > 0) {
    rows.push({
      id: QUESTIONS_CONVERSATION,
      title: args.t("agent.team.needsYou"),
      preview: args.firstQuestionReason ?? "",
      at: null,
      badge: args.openCount,
      live: false,
    })
  }
  const byNewest = [...args.runs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  for (const run of byNewest) {
    const drafts = run.proposedDrafts ?? 0
    const span = humanPassageLabel(run.spanLabel)
    const status = args.runStatusLabel(run)
    rows.push({
      id: runThreadId(run.runId),
      title: args.runTitle(run),
      preview:
        drafts > 0
          ? args.t("agent.team.draftsReady", { count: drafts })
          : span
            ? `${status} — ${span}`
            : status,
      at: run.updatedAt,
      badge: drafts,
      live: isRunWorkingStatus(run.status),
    })
  }
  return rows
}
