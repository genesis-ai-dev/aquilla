/**
 * TeamChannelComposer.tsx — scoped steering composer for Team conversations.
 *
 * There is only ever ONE message box, and where it sends must be
 * unmistakable. The channel callback addresses the shared orchestrator
 * session (compose-send.ts). With a run conversation
 * open it steps in by an inline-start margin and wears a scope chip naming
 * the teammate and passage it is talking to; the message goes to that run as
 * a steering direction, never to the chat. A FINISHED run can be re-opened by
 * messaging (v2.2): the message starts a fresh run on the same file and rides
 * along as its first steering direction — role-gated by the caller. Only when
 * the viewer cannot start runs does the box close and say so.
 * The caller supplies owner/project/conversation identity; failed handoffs
 * keep the exact document and error in that scope.
 */

import { useEffect, useRef } from "react"
import { ChatComposer } from "@/components/chat/ChatComposer"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n/I18nProvider"
import { serializeWithChips, type ContextChip } from "@/lib/agent/context-chip"
import { composerDraftKey, composerDraftStore, type ComposerDraftScope } from "@/lib/agent/composer-drafts"
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
  draftScope: ComposerDraftScope
  /** Null → Team chat (message the orchestrator). */
  thread: TeamComposerThread | null
  /** A session JWT exists — without one nothing can be sent. */
  isConfigured: boolean
  /** The shared chat session is streaming (Team chat only). */
  isStreaming: boolean
  onStop: () => void
  onSendToChannel: (text: string, chips: ContextChip[]) => void | boolean | Promise<void | boolean>
}

export function TeamChannelComposer(props: TeamChannelComposerProps) {
  return <ScopedTeamChannelComposer key={composerDraftKey(props.draftScope)} {...props} />
}

function ScopedTeamChannelComposer({
  draftScope,
  thread,
  isConfigured,
  isStreaming,
  onStop,
  onSendToChannel,
}: TeamChannelComposerProps) {
  const t = useT()
  const draftStore = composerDraftStore(draftScope)
  const reopenedRunId = useRef<string | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const personaName = thread ? t(AGENT_PERSONAS[thread.personaId].nameKey) : null
  const threadCanSend = Boolean(thread && (thread.steerable || thread.reopen))
  const canSend = thread ? isConfigured && threadCanSend : isConfigured

  const placeholder = !thread
    ? t("agent.team.composer.channelPlaceholder")
    : thread.steerable
      ? t("agent.team.composer.threadPlaceholder", { persona: personaName ?? "" })
      : thread.reopen
        ? t("agent.team.composer.reopenPlaceholder")
        : t("agent.team.composer.finishedPlaceholder")

  const handleSend = async ({ text, chips }: { text: string; chips: ContextChip[] }) => {
    if (!thread) return onSendToChannel(text, chips)
    const trimmed = text.trim()
    if (!trimmed && chips.length === 0) return false
    const { wire } = serializeWithChips(trimmed, chips)
    try {
      if (thread.steerable) {
        await sendContextualSteering(thread.runId, wire)
        return true
      }
      const reopen = thread.reopen
      if (!reopen) return false
      // If starting succeeded but steering failed, retry that direction on the
      // already-created run rather than starting duplicate work.
      if (!reopenedRunId.current) {
        const { runId } = await startFileContextualRun(reopen.projectId, reopen.fileId, reopen.targetLang)
        reopenedRunId.current = runId
      }
      await sendContextualSteering(reopenedRunId.current, wire)
      if (mountedRef.current) reopen.onReopened(reopenedRunId.current)
      return true
    } catch {
      draftStore.setSendError(t("agent.team.composer.sendFailed"))
      return false
    }
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
      <ChatComposer
        draftScope={draftScope}
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
