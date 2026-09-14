/**
 * AgentDockPanel.tsx — the left dock's Agent tab: the team's THREADS LIST
 * (v2.2 three-column layout, 2026-08-28). The old compact chat lived here and
 * read as a confusing "preview"; now the dock answers "what is the team
 * doing" at a glance and clicking a conversation opens it in the agent
 * surface. Selection is URL-driven (CONVERSATION_PARAM), so this list and the
 * center pane can never disagree about what is open.
 *
 * For scripture files the Summarize book/chapter quick actions remain — they
 * now hand their prompt to the agent surface (pendingPrompt) instead of a
 * dock-local composer.
 */

import { useMemo } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { Bot, Maximize2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"
import { useAgentSession } from "@/lib/agent/session-store"
import {
  CONVERSATION_PARAM,
  TEAM_CHAT_CONVERSATION,
} from "@/lib/agent/team-channel"
import {
  buildConversationRows,
  useTeamConversations,
} from "@/lib/agent/team-conversations"
import type { ContextualRunRecord } from "@/lib/contextual/transport"
import { TeamConversationList } from "./agent/TeamConversationList"
import { runStatusKey } from "./agent/team-run-status"
import { bookSummaryPrompt, chapterSummaryPrompt } from "@/lib/summary-prompts"

/** Scripture context that powers the Summarize book/chapter buttons. */
export interface BibleSummaryContext {
  /** The open book's display name (drives "Summarize book"). */
  bookName?: string
  /** The focused cell's chapter ref, e.g. "GEN 1" (drives "Summarize chapter").
   *  Null when no verse is focused — the chapter button is then disabled. */
  chapterRef?: string | null
}

export interface AgentDockPanelProps {
  projectId: string
  /** Session-store owner key — must match the agent surface's wiring. */
  author: string
  /** File display names for conversation titles. */
  fileNames?: ReadonlyMap<string, string>
  /** When a scripture file is open, shows Summarize book/chapter buttons. */
  bibleSummary?: BibleSummaryContext | null
  /** Hand a quick-action prompt to the agent surface (it opens the chat). */
  onSummaryPrompt?: (prompt: string) => void
  /** Opens the agent surface (same as selecting a conversation). */
  onExpand?: () => void
}

export function AgentDockPanel({
  projectId,
  author,
  fileNames,
  bibleSummary,
  onSummaryPrompt,
  onExpand,
}: AgentDockPanelProps) {
  const t = useT()
  const navigate = useNavigate()
  const location = useLocation()
  const { state } = useAgentSession(projectId, author)
  const { runs, decisions } = useTeamConversations(projectId)

  const onAgentSurface = location.pathname.endsWith("/agent")
  const selectedId = onAgentSurface
    ? new URLSearchParams(location.search).get(CONVERSATION_PARAM) ?? TEAM_CHAT_CONVERSATION
    : ""

  const runTitle = useMemo(
    () => (run: ContextualRunRecord) =>
      fileNames?.get(run.fileId) ?? run.spanLabel ?? t("agent.team.unnamedThread"),
    [fileNames, t],
  )
  const rows = useMemo(
    () =>
      buildConversationRows({
        chatRuns: state.runs,
        isStreaming: state.isStreaming,
        runs: runs ?? [],
        openCount: decisions?.openCount ?? 0,
        firstQuestionReason: decisions?.decisions[0]?.reason ?? null,
        runTitle,
        runStatusLabel: (run) => t(runStatusKey(run)),
        t,
      }),
    [state.runs, state.isStreaming, runs, decisions, runTitle, t],
  )

  const openConversation = (id: string) => {
    // Always explicit — the param is what tells the workbench to land on the
    // Team surface rather than its default Chat tab.
    navigate(`/project/${projectId}/agent?${CONVERSATION_PARAM}=${encodeURIComponent(id)}`)
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Bot className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">{t("agent.dock.title")}</span>
        <span className="ms-auto flex items-center gap-1">
          {onExpand && (
            <AppTooltip content={t("agent.dock.openInEditorTooltip")}>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={onExpand}
                className="text-muted-foreground"
                aria-label={t("agent.dock.openInEditorAriaLabel")}
              >
                <Maximize2 />
              </Button>
            </AppTooltip>
          )}
        </span>
      </div>

      {/* Scripture quick actions — prompts run in the agent surface. */}
      {bibleSummary && onSummaryPrompt && (
        <div className="flex flex-wrap gap-1 border-b px-2 py-1.5">
          {bibleSummary.bookName && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-6 text-[11px]"
              title={t("workspace.agentDockPanel.summarizeBookTitle", {
                book: bibleSummary.bookName,
              })}
              onClick={() => onSummaryPrompt(bookSummaryPrompt(bibleSummary.bookName!))}
            >
              {/* i18n-exempt existing untranslated quick-action labels (AQU-320) */}
              Summarize book
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 text-[11px]"
            disabled={!bibleSummary.chapterRef}
            title={
              bibleSummary.chapterRef
                ? // i18n-exempt pre-existing untranslated quick-action title (AQU-320)
                  `Summarize ${bibleSummary.chapterRef} using vetted Bible resources`
                : // i18n-exempt pre-existing untranslated quick-action title (AQU-320)
                  "Focus a verse to summarize its chapter"
            }
            onClick={() =>
              bibleSummary.chapterRef
              && onSummaryPrompt(chapterSummaryPrompt(bibleSummary.chapterRef))
            }
          >
            {/* i18n-exempt existing untranslated quick-action labels (AQU-320) */}
            Summarize chapter
          </Button>
        </div>
      )}

      <TeamConversationList rows={rows} selectedId={selectedId} onSelect={openConversation} />
    </div>
  )
}
