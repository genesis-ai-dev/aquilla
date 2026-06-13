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
import { ChatComposer } from "@/components/chat/ChatComposer"
import { ChatContextPin } from "@/components/chat/ChatContextPin"
import type { CellContext } from "@/hooks/useChat"
import type { CellData } from "@/hooks/useCells"
import type { TranslationRule } from "@/lib/parsers/types"
import { runAgent } from "@/lib/agent/agent-client"
import type { ApplyContext } from "@/lib/agent/apply"
import { createRun, failRun, reduceRunFrame, type AgentRunUi } from "@/lib/agent/run-state"
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
}: AgentDockViewProps) {
  const [runs, setRuns] = useState<AgentRunUi[]>([])
  const [includeContext, setIncludeContext] = useState(true)
  const [isStreaming, setIsStreaming] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Abort any in-flight run on unmount (mode switch / dock close).
  useEffect(() => () => abortRef.current?.abort(), [])

  // Keep the newest frames in view while streaming.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [runs])

  const updateRun = useCallback((localId: string, next: (run: AgentRunUi) => AgentRunUi) => {
    setRuns((prev) => prev.map((r) => (r.localId === localId ? next(r) : r)))
  }, [])

  const sendPrompt = useCallback(
    async (text: string) => {
      const prompt = text.trim()
      if (!prompt || !jwt || isStreaming) return

      const run = createRun(prompt)
      setRuns((prev) => [...prev, run])
      setIsStreaming(true)
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      // Prior turns: each finished run is one user + one assistant turn.
      const messages: { role: "user" | "assistant"; content: string }[] = []
      for (const r of runs) {
        messages.push({ role: "user", content: r.prompt })
        if (r.assistantText) messages.push({ role: "assistant", content: r.assistantText })
      }
      messages.push({ role: "user", content: prompt })
      const truncated = messages.slice(-MAX_WIRE_TURNS)

      try {
        await runAgent({
          request: {
            projectId,
            messages: truncated,
            ...(includeContext && (context.fileId || context.cellId)
              ? { context: { ...context } }
              : {}),
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

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-2">
        {runs.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center text-muted-foreground">
            <Bot className="h-5 w-5" />
            <p className="text-xs">
              {jwt
                ? "Ask the agent to draft, check, or explain — it proposes changes you review and apply."
                : "Sign in to use the agent."}
            </p>
          </div>
        )}
        {runs.map((run) => (
          <div key={run.localId} className="space-y-2">
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
        ))}
      </div>

      <ChatComposer
        isStreaming={isStreaming}
        isConfigured={Boolean(jwt)}
        onSend={(text) => void sendPrompt(text)}
        onStop={stop}
        compact
      />
    </div>
  )
}
