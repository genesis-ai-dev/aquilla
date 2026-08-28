/**
 * TeamChannelComposer.tsx — the one composer at the bottom of the Team tab.
 *
 * There is only ever ONE message box, and where it sends must be
 * unmistakable. In Team chat it addresses the orchestrator — the same shared
 * chat session the Chat tab drives (compose-send.ts). With a run conversation
 * open it steps in by an inline-start margin and wears a scope chip naming
 * the teammate and passage it is talking to; the message goes to that run as
 * a steering direction, never to the chat. A FINISHED run can be re-opened by
 * messaging (v2.2): the message starts a fresh run on the same file and rides
 * along as its first steering direction — role-gated by the caller. Only when
 * the viewer cannot start runs does the box close and say so.
 */

import { useState } from "react"
import { ChatComposer } from "@/components/chat/ChatComposer"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n/I18nProvider"
import type { ContextChip } from "@/lib/agent/context-chip"
import { AGENT_PERSONAS, type AgentPersonaId } from "@/lib/agent/personas"
import { sendContextualSteering, startFileContextualRun } from "@/lib/contextual/transport"
import { PersonaAvatar } from "./PersonaAvatar"

export interface TeamComposerThread {
  runId: string
  personaId: AgentPersonaId
  /** Passage or file the run is working — the second half of the scope chip. */
  scopeLabel: string
  /** False once the run is done/failed/terminated: steering has no reader. */
  steerable: boolean
  /** Set when a terminal run may be RE-OPENED by messaging: a send starts a
   *  fresh run on this file, seeded with the message as steering. Omitted →
   *  the box closes with an explanation instead. */
  reopen?: {
    projectId: string
    fileId: string
    targetLang: string
    /** Select the fresh run's conversation once it exists. */
    onReopened: (runId: string) => void
  }
}

export interface TeamChannelComposerProps {
  /** Null → Team chat (message the orchestrator). */
  thread: TeamComposerThread | null
  /** A session JWT exists — without one nothing can be sent. */
  isConfigured: boolean
  /** The shared chat session is streaming (Team chat only). */
  isStreaming: boolean
  onStop: () => void
  onSendToChannel: (text: string, chips: ContextChip[]) => void
}

export function TeamChannelComposer({
  thread,
  isConfigured,
  isStreaming,
  onStop,
  onSendToChannel,
}: TeamChannelComposerProps) {
  const t = useT()
  const [sendFailed, setSendFailed] = useState(false)
  const [reopening, setReopening] = useState(false)

  const personaName = thread ? t(AGENT_PERSONAS[thread.personaId].nameKey) : null
  const threadCanSend = Boolean(thread && (thread.steerable || thread.reopen)) && !reopening
  const canSend = thread ? isConfigured && threadCanSend : isConfigured

  const placeholder = !thread
    ? t("agent.team.composer.channelPlaceholder")
    : thread.steerable
      ? t("agent.team.composer.threadPlaceholder", { persona: personaName ?? "" })
      : thread.reopen
        ? t("agent.team.composer.reopenPlaceholder")
        : t("agent.team.composer.finishedPlaceholder")

  const handleSend = ({ text, chips }: { text: string; chips: ContextChip[] }) => {
    setSendFailed(false)
    if (!thread) {
      onSendToChannel(text, chips)
      return
    }
    const trimmed = text.trim()
    if (!trimmed) return
    if (thread.steerable) {
      // Steering wakes a parked run server-side; the client only reports failure.
      void sendContextualSteering(thread.runId, trimmed).catch(() => setSendFailed(true))
      return
    }
    const reopen = thread.reopen
    if (!reopen) return
    setReopening(true)
    void startFileContextualRun(reopen.projectId, reopen.fileId, reopen.targetLang)
      .then(async ({ runId }) => {
        await sendContextualSteering(runId, trimmed).catch(() => {
          // The run started; a lost direction is reported, not fatal.
          setSendFailed(true)
        })
        reopen.onReopened(runId)
      })
      .catch(() => setSendFailed(true))
      .finally(() => setReopening(false))
  }

  return (
    <div className={cn("shrink-0", thread && "ms-12 border-s")}>
      {thread && (
        <div
          data-testid="team-composer-scope"
          className="flex items-center gap-1.5 border-t px-3 pt-2 text-[11px] text-muted-foreground"
        >
          <span aria-hidden>→</span>
          <PersonaAvatar personaId={thread.personaId} size="sm" />
          <span className="min-w-0 truncate">
            {t("agent.team.composer.scope", {
              persona: personaName ?? "",
              scope: thread.scopeLabel,
            })}
          </span>
        </div>
      )}
      {sendFailed && (
        <p role="alert" className="px-3 pt-1 text-[11px] text-destructive">
          {t("agent.team.composer.sendFailed")}
        </p>
      )}
      <ChatComposer
        isStreaming={thread ? false : isStreaming}
        isConfigured={canSend}
        onSend={handleSend}
        onStop={onStop}
        compact
        queueWhileStreaming={!thread}
        placeholder={placeholder}
      />
    </div>
  )
}
