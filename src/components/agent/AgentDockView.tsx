/**
 * AgentDockView.tsx — Agent mode body for the chat dock.
 *
 * A thin mount over the project's shared agent session
 * (src/lib/agent/session-store.ts): the store owns runs/streaming/queueing
 * and the server-session id, so the full-screen workbench renders the SAME
 * conversation and an in-flight run survives dock unmounts. This component
 * owns only presentation wiring: composer, context pin, proposal Apply.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { Bot } from "lucide-react"
import { ChatComposer, type ChatComposerHandle, type SuggestedAction } from "@/components/chat/ChatComposer"
import { ChatContextPin } from "@/components/chat/ChatContextPin"
import type { CellContext } from "@/lib/cell-context"
import { serializeWithChips, type ContextChip } from "@/lib/agent/context-chip"
import { expandSlashCommand } from "@/lib/agent/slash-commands"
import { getTranslatorProfile, profileForPrompt } from "@/lib/translator-profile"
import type { CellData } from "@/hooks/useCells"
import type { TranslationRule } from "@/lib/parsers/types"
import type { ApplyContext } from "@/lib/agent/apply"
import { useAgentSession } from "@/lib/agent/session-store"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { AgentRunView } from "./AgentRunView"
import { ProposalCard } from "./ProposalCard"
import { AquiferProposalCard } from "./AquiferProposalCard"

export interface AgentDockViewProps {
  projectId: string
  /** Frontier session JWT; null = not signed in (composer disabled). */
  jwt: string | null
  /** Current username — author on applied events. */
  author: string
  /** Current user's project role level (project.syncRole.level). */
  roleLevel: number | null
  /** Focused file/cell ids — sent as run context when the pin is on. */
  context: { fileId?: string; cellId?: string }
  /** Open file's name — keeps the pin pill honest when only file context is sent. */
  fileName?: string
  /** Focused cell display info for the context pin strip. */
  currentCell: CellContext | null
  /** Project's active rules for proposal lint. */
  rules: TranslationRule[]
  /** Live cell lookup from useCells. */
  resolveCell?: (cellId: string) => CellData | undefined
  /** Post-apply hook: flush outbox + revalidate the touched cells. */
  onApplied?: (eventIds: string[], cellIds: string[]) => void | Promise<void>
  /** One-tap prompts shown above the composer (e.g. Summarize book/chapter). */
  suggestedActions?: SuggestedAction[]
  /** A prompt to run as soon as the view is ready (set when the user taps a
   *  suggested action from chat mode, which switches to agent mode). */
  pendingPrompt?: string | null
  /** Called once the pending prompt has been dispatched, so the parent clears it. */
  onPendingPromptConsumed?: () => void
  /** A chip to insert into the composer as soon as the view is ready (set when
   *  the user taps "Ask AI" on a source selection). */
  pendingChip?: ContextChip | null
  /** Called once the pending chip has been inserted, so the parent clears it. */
  onPendingChipConsumed?: () => void
}

export function AgentDockView({
  projectId,
  jwt,
  author,
  roleLevel,
  context,
  fileName,
  currentCell,
  rules,
  resolveCell,
  onApplied,
  suggestedActions,
  pendingPrompt,
  onPendingPromptConsumed,
  pendingChip,
  onPendingChipConsumed,
}: AgentDockViewProps) {
  const { state, send, stop } = useAgentSession(projectId)
  const [includeContext, setIncludeContext] = useState(true)
  const composerRef = useRef<ChatComposerHandle>(null)

  const sendPrompt = useCallback(
    (text: string, chips: ContextChip[] = []) => {
      if ((!text.trim() && chips.length === 0) || !jwt) return
      // Slash commands expand into vetted prompts; the bubble keeps the typed
      // command (CLI-style). Chips skip expansion — a chip message is already
      // a specific ask, not a command.
      const expanded = chips.length === 0 ? expandSlashCommand(text) : null
      // `display` (with [ref] chips) shows in the bubble; `wire` (tokens +
      // legend) is what the model receives.
      const { wire, display } = expanded
        ? { wire: expanded, display: text.trim() }
        : serializeWithChips(text, chips)
      // Read the profile at send time (fresh, no extra re-render). The server
      // re-caps every field; this just avoids sending an empty object.
      const translatorProfile = profileForPrompt(getTranslatorProfile())
      send({
        wire,
        display,
        jwt,
        request: {
          projectId,
          ...(includeContext && (context.fileId || context.cellId)
            ? { context: { ...context } }
            : {}),
          ...(translatorProfile ? { translatorProfile } : {}),
        },
      })
    },
    [jwt, send, projectId, includeContext, context],
  )

  // Run a prompt handed in from a suggested action (tapped in chat mode, which
  // flips the dock to agent mode). The store queues it if a run is streaming,
  // so dispatch immediately and clear exactly once.
  useEffect(() => {
    if (!pendingPrompt || !jwt) return
    sendPrompt(pendingPrompt)
    onPendingPromptConsumed?.()
  }, [pendingPrompt, jwt, sendPrompt, onPendingPromptConsumed])

  // Insert a chip handed in from the editor's "Ask AI" selection action.
  useEffect(() => {
    if (!pendingChip) return
    composerRef.current?.insertChip(pendingChip)
    onPendingChipConsumed?.()
  }, [pendingChip, onPendingChipConsumed])

  const applyContext: ApplyContext = {
    projectId,
    author,
    resolveCell: resolveCell
      ? (cellId) => {
          const cell = resolveCell(cellId)
          return cell
            ? { targetEventId: cell.targetEventId, sourceEventId: cell.sourceEventId }
            : undefined
        }
      : undefined,
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatContextPin
        includeCellContext={includeContext}
        onToggle={setIncludeContext}
        currentCell={currentCell}
        fileName={fileName}
        compact
      />

      {state.runs.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-3 text-center text-muted-foreground">
          <Bot className="h-5 w-5" />
          <p className="text-xs">
            {jwt
              ? "Ask the agent to draft, check, or explain — it proposes changes you review and apply."
              : "Sign in to use the agent."}
          </p>
        </div>
      ) : (
        <MessageScrollerProvider>
          <MessageScroller className="flex-1">
            <MessageScrollerViewport>
              <MessageScrollerContent className="px-3 py-2">
                {state.runs.map((run) => (
                  <MessageScrollerItem key={run.localId} messageId={run.localId} scrollAnchor>
                    <AgentRunView
                      run={run}
                      renderProposal={(proposal) => (
                        <ProposalCard
                          key={proposal.proposalId}
                          proposal={proposal}
                          roleLevel={roleLevel}
                          rules={rules}
                          resolveCell={resolveCell}
                          applyContext={applyContext}
                          onApplied={onApplied}
                        />
                      )}
                      renderAquiferProposal={(proposal) => (
                        <AquiferProposalCard
                          key={proposal.proposalId}
                          proposal={proposal}
                          projectId={projectId}
                          jwt={jwt}
                        />
                      )}
                    />
                  </MessageScrollerItem>
                ))}
                {state.queued.length > 0 && (
                  <div className="px-1 py-0.5 text-[11px] text-muted-foreground">
                    {state.queued.length === 1
                      ? "1 message queued — sends when the current run finishes."
                      : `${state.queued.length} messages queued — send in order when the current run finishes.`}
                  </div>
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
      )}

      <ChatComposer
        ref={composerRef}
        isStreaming={state.isStreaming}
        isConfigured={Boolean(jwt)}
        onSend={({ text, chips }) => sendPrompt(text, chips)}
        onStop={stop}
        compact
        suggestedActions={suggestedActions}
        queueWhileStreaming
        placeholder="Ask the agent… (/draft, /check, /find, /status)"
      />
    </div>
  )
}
