/**
 * TeamChannelComposer.tsx — the one composer at the bottom of the Team tab
 * (v2 of the 2026-08-28 social-workspace design).
 *
 * There is only ever ONE message box, and where it sends must be
 * unmistakable. In the main channel it addresses the orchestrator — the same
 * shared chat session the Chat tab drives (compose-send.ts). With a run
 * thread open it steps in by an inline-start margin, matching the collapsed
 * spine, and wears a scope chip naming the teammate and passage it is talking
 * to; the message then goes to that run as a steering direction, never to the
 * chat. A finished run has nobody left to read a direction, so the box closes
 * and says so rather than silently swallowing the text.
 */

import { useState } from "react"
import { ChatComposer } from "@/components/chat/ChatComposer"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n/I18nProvider"
import type { ContextChip } from "@/lib/agent/context-chip"
import { AGENT_PERSONAS, type AgentPersonaId } from "@/lib/agent/personas"
import { sendContextualSteering } from "@/lib/contextual/transport"
import { PersonaAvatar } from "./PersonaAvatar"

export interface TeamComposerThread {
  runId: string
  personaId: AgentPersonaId
  /** Passage or file the run is working — the second half of the scope chip. */
  scopeLabel: string
  /** False once the run is done/failed/terminated: steering has no reader. */
  steerable: boolean
}

export interface TeamChannelComposerProps {
  /** Null → the main channel (message the orchestrator). */
  thread: TeamComposerThread | null
  /** A session JWT exists — without one nothing can be sent. */
  isConfigured: boolean
  /** The shared chat session is streaming (main channel only). */
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

  const personaName = thread ? t(AGENT_PERSONAS[thread.personaId].nameKey) : null
  const canSend = thread ? isConfigured && thread.steerable : isConfigured

  const placeholder = !thread
    ? t("agent.team.composer.channelPlaceholder")
    : thread.steerable
      ? t("agent.team.composer.threadPlaceholder", { persona: personaName ?? "" })
      : t("agent.team.composer.finishedPlaceholder")

  const handleSend = ({ text, chips }: { text: string; chips: ContextChip[] }) => {
    setSendFailed(false)
    if (!thread) {
      onSendToChannel(text, chips)
      return
    }
    if (!thread.steerable) return
    const trimmed = text.trim()
    if (!trimmed) return
    // Steering wakes a parked run server-side; the client only reports failure.
    void sendContextualSteering(thread.runId, trimmed).catch(() => setSendFailed(true))
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
