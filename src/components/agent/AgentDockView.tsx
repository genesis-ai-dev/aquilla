/**
 * AgentDockView.tsx — Agent mode body for the chat dock.
 *
 * Holds the run list state: each composer send POSTs to the agent endpoint
 * (agent-client.ts), folds SSE frames into an AgentRunUi (run-state.ts), and
 * renders AgentRunView + ProposalCards per run. The composer and context pin
 * are the SAME shared chat components the chat mode uses; Chat mode behavior
 * is untouched (this component only mounts in Agent mode).
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { Bot } from "lucide-react"
import { ChatComposer, type ChatComposerHandle, type SuggestedAction } from "@/components/chat/ChatComposer"
import { ChatContextPin } from "@/components/chat/ChatContextPin"
import type { CellContext } from "@/lib/cell-context"
import { serializeWithChips, type ContextChip } from "@/lib/agent/context-chip"
import { getTranslatorProfile, profileForPrompt } from "@/lib/translator-profile"
import type { CellData } from "@/hooks/useCells"
import type { TranslationRule } from "@/lib/parsers/types"
import { runAgent } from "@/lib/agent/agent-client"
import type { ApplyContext } from "@/lib/agent/apply"
import { createRun, failRun, reduceRunFrame, type AgentRunUi } from "@/lib/agent/run-state"
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

/** ≤10 turns on the wire — the contract says the client truncates. */
const MAX_WIRE_TURNS = 10

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
  const [runs, setRuns] = useState<AgentRunUi[]>([])
  const [includeContext, setIncludeContext] = useState(true)
  const [isStreaming, setIsStreaming] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const composerRef = useRef<ChatComposerHandle>(null)

  // Abort any in-flight run on unmount (mode switch / dock close).
  useEffect(() => () => abortRef.current?.abort(), [])

  const updateRun = useCallback((localId: string, next: (run: AgentRunUi) => AgentRunUi) => {
    setRuns((prev) => prev.map((r) => (r.localId === localId ? next(r) : r)))
  }, [])

  const sendPrompt = useCallback(
    async (text: string, chips: ContextChip[] = []) => {
      if ((!text.trim() && chips.length === 0) || !jwt || isStreaming) return
      // `display` (with [ref] chips) shows in the bubble; `wire` (tokens +
      // legend) is what the model receives.
      const { wire, display } = serializeWithChips(text, chips)

      const run = createRun(display, wire)
      setRuns((prev) => [...prev, run])
      setIsStreaming(true)
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      // Prior turns: each finished run is one user + one assistant turn. Send
      // the stored wire content so prior chip legends ride along (and evict
      // naturally via the ≤10-turn slice).
      const messages: { role: "user" | "assistant"; content: string }[] = []
      for (const r of runs) {
        messages.push({ role: "user", content: r.wireContent ?? r.prompt })
        if (r.assistantText) messages.push({ role: "assistant", content: r.assistantText })
      }
      messages.push({ role: "user", content: wire })
      const truncated = messages.slice(-MAX_WIRE_TURNS)

      // Read the profile at send time (fresh, no extra re-render). The server
      // re-caps every field; this just avoids sending an empty object.
      const translatorProfile = profileForPrompt(getTranslatorProfile())

      try {
        await runAgent({
          request: {
            projectId,
            messages: truncated,
            ...(includeContext && (context.fileId || context.cellId)
              ? { context: { ...context } }
              : {}),
            ...(translatorProfile ? { translatorProfile } : {}),
          },
          jwt,
          signal: controller.signal,
          onFrame: (frame) => updateRun(run.localId, (r) => reduceRunFrame(r, frame)),
        })
        // Stream closed without a done frame → don't leave a forever-spinner.
        updateRun(run.localId, (r) =>
          r.status === "running" ? { ...r, status: "ok" } : r,
        )
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          updateRun(run.localId, (r) =>
            r.status === "running" ? failRun(r, "Stopped.") : r,
          )
        } else {
          updateRun(run.localId, (r) =>
            failRun(r, err instanceof Error ? err.message : String(err)),
          )
        }
      } finally {
        setIsStreaming(false)
        if (abortRef.current === controller) abortRef.current = null
      }
    },
    [jwt, isStreaming, runs, projectId, includeContext, context, updateRun],
  )

  const stop = useCallback(() => abortRef.current?.abort(), [])

  // Run a prompt handed in from a suggested action (tapped in chat mode, which
  // flips the dock to agent mode). Waits out any in-flight run, then dispatches
  // once and tells the parent to clear it so it fires exactly once.
  useEffect(() => {
    if (!pendingPrompt || !jwt || isStreaming) return
    void sendPrompt(pendingPrompt)
    onPendingPromptConsumed?.()
  }, [pendingPrompt, jwt, isStreaming, sendPrompt, onPendingPromptConsumed])

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

      {runs.length === 0 ? (
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
                {runs.map((run) => (
                  <MessageScrollerItem key={run.localId} messageId={run.localId} scrollAnchor>
                    <div className="flex flex-col gap-2">
                      <AgentRunView run={run} />
                      {run.proposals.map((proposal) => (
                        <ProposalCard
                          key={proposal.proposalId}
                          proposal={proposal}
                          roleLevel={roleLevel}
                          rules={rules}
                          resolveCell={resolveCell}
                          applyContext={applyContext}
                          onApplied={onApplied}
                        />
                      ))}
                      {(run.aquiferProposals ?? []).map((proposal) => (
                        <AquiferProposalCard
                          key={proposal.proposalId}
                          proposal={proposal}
                          projectId={projectId}
                          jwt={jwt}
                        />
                      ))}
                    </div>
                  </MessageScrollerItem>
                ))}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
      )}

      <ChatComposer
        ref={composerRef}
        isStreaming={isStreaming}
        isConfigured={Boolean(jwt)}
        onSend={({ text, chips }) => void sendPrompt(text, chips)}
        onStop={stop}
        compact
        suggestedActions={suggestedActions}
      />
    </div>
  )
}
