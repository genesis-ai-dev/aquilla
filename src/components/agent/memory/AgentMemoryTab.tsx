/**
 * AgentMemoryTab.tsx — the "memory" tab in AgentWorkbench (AQU-AGENT
 * contracts §5, owner W1E). Two sections: Proposed queue and Approved list.
 * AQU-2342 retired the third, the agent's own "Project brief": how the AI
 * should translate the project now lives in ONE place, Living Memory →
 * Instructions, which the agent reads like every other drafting path.
 *
 * Data flow: fetches memories (all statuses) once per `projectId`, then
 * applies optimistic status flips locally (revert on a
 * failed request) so approve/reject/edit feel instant without a full refetch
 * round-trip. `jwt`/`username` come from useFrontierSession, matching
 * ApiTokensSection's pattern; `roleLevel` is passed in the same shape
 * ProposalCard/role-floors.ts expect (`project.syncRole?.level`, null when
 * unknown — fail-open, the server re-checks everything).
 *
 * SWARM-TODO(aqu-agent): once W1B's harness lands, wire provenance display
 * to actual run/session ids end-to-end (this UI already renders
 * `provenance.runId`/`sessionId` when present — nothing further needed here
 * unless the shape drifts from §3).
 *
 * mem-M5 (memory-notice liveness): this tab and AgentRunView's chat timeline
 * both key off `projectId`, so a review here calls straight into
 * `agentSessionStore(projectId, username).markMemoryReviewed` — the
 * store already exists as the single source of truth for run state (see
 * session-store.ts), so that's the "clean channel" rather than a window
 * event: any mounted AgentRunView subscribed to the same store re-renders
 * with the notice flipped to "reviewed".
 *
 * mem-m2 (badge refetch): this tab also subscribes to the same store to
 * count `memory-proposed` timeline items; when that count grows (a new
 * `memory.proposed` frame landed on a run for this project while the tab is
 * open), it refetches the memory list so the Proposed badge/queue catch up
 * without waiting for the next full remount.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useT } from "@/lib/i18n/I18nProvider"
import { RichMessage } from "@/lib/i18n/RichMessage"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { agentSessionStore, useAgentSession } from "@/lib/agent/session-store"
import {
  editAgentMemory,
  listAgentMemories,
  reviewAgentMemory,
  SupersedesHumanEditedError,
  type AgentMemory,
} from "@/lib/agent/memory-api"
import { ApprovedMemoryList } from "./ApprovedMemoryList"
import { ProposedMemoryList } from "./ProposedMemoryList"

interface SupersedePrompt {
  memory: AgentMemory
  path: string
  existingId?: string
}

export interface AgentMemoryTabProps {
  projectId: string
  /** Current user's project role level (project.syncRole?.level); null = unknown. */
  roleLevel: number | null
}

type LoadState = "idle" | "loading" | "loaded" | "error"

export default function AgentMemoryTab({ projectId, roleLevel }: AgentMemoryTabProps) {
  const t = useT()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const username = session?.username ?? null
  const { state: agentSessionState } = useAgentSession(projectId, username)

  const [memories, setMemories] = useState<AgentMemory[]>([])
  const [state, setState] = useState<LoadState>("idle")
  const [error, setError] = useState<string | null>(null)
  const [busyMemoryIds, setBusyMemoryIds] = useState<Set<string>>(new Set())
  const [supersedePrompt, setSupersedePrompt] = useState<SupersedePrompt | null>(null)

  const load = useCallback(async () => {
    if (!jwt) return
    setState("loading")
    setError(null)
    try {
      setMemories(await listAgentMemories(jwt, projectId))
      setState("loaded")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load agent memory.")
      setState("error")
    }
  }, [jwt, projectId])

  useEffect(() => {
    void load()
  }, [load])

  // mem-m2: refetch the memory list whenever a new memory.proposed item shows
  // up on any run in this project's agent session while the tab is mounted,
  // so the Proposed badge/queue stay live without a remount.
  const memoryProposedCount = useMemo(
    () => agentSessionState.runs.reduce((n, r) => n + r.items.filter((i) => i.kind === "memory-proposed").length, 0),
    [agentSessionState.runs],
  )
  const prevMemoryProposedCount = useRef(memoryProposedCount)
  useEffect(() => {
    if (memoryProposedCount > prevMemoryProposedCount.current && jwt) {
      listAgentMemories(jwt, projectId)
        .then(setMemories)
        .catch(() => {
          // Best-effort refresh — the next full load() will retry.
        })
    }
    prevMemoryProposedCount.current = memoryProposedCount
  }, [memoryProposedCount, jwt, projectId])

  const proposed = useMemo(() => memories.filter((m) => m.status === "proposed"), [memories])
  const approved = useMemo(() => memories.filter((m) => m.status === "approved"), [memories])

  const withBusyMemory = useCallback(async (id: string, fn: () => Promise<void>) => {
    setBusyMemoryIds((prev) => new Set(prev).add(id))
    try {
      await fn()
    } finally {
      setBusyMemoryIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }, [])

  const reviewMemory = useCallback(
    (memory: AgentMemory, action: "approve" | "reject", supersedeHumanEdited?: boolean) => {
      if (!jwt) return
      const original = memory
      // Optimistic flip; revert only this row (by id) on failure — races-F5:
      // an absolute-snapshot revert would clobber other rows that changed
      // (from a concurrent review) while this request was in flight.
      setMemories((cur) =>
        cur.map((m) => (m.id === memory.id ? { ...m, status: action === "approve" ? "approved" : "rejected" } : m)),
      )
      void withBusyMemory(memory.id, async () => {
        try {
          const updated = supersedeHumanEdited
            ? await reviewAgentMemory(jwt, projectId, memory.id, action, true)
            : await reviewAgentMemory(jwt, projectId, memory.id, action)
          setMemories((cur) => cur.map((m) => (m.id === updated.id ? updated : m)))
          // mem-M5: flip the matching memory.proposed chat notice, if any.
          agentSessionStore(projectId, username).markMemoryReviewed(updated.id)
        } catch (err) {
          setMemories((cur) => cur.map((m) => (m.id === original.id ? original : m)))
          if (err instanceof SupersedesHumanEditedError) {
            setSupersedePrompt({ memory: original, path: err.path ?? original.path, existingId: err.existingId })
            return
          }
          setError(err instanceof Error ? err.message : "Failed to review memory.")
        }
      })
    },
    [jwt, projectId, withBusyMemory],
  )

  const confirmSupersede = useCallback(() => {
    if (!supersedePrompt) return
    const { memory } = supersedePrompt
    setSupersedePrompt(null)
    reviewMemory(memory, "approve", true)
  }, [supersedePrompt, reviewMemory])

  const editMemory = useCallback(
    async (memory: AgentMemory, content: string) => {
      if (!jwt) throw new Error("Not signed in.")
      const updated = await editAgentMemory(jwt, projectId, memory.id, content)
      setMemories((cur) => cur.map((m) => (m.id === updated.id ? updated : m)))
    },
    [jwt, projectId],
  )

  if (!jwt) {
    return <p className="p-3 text-xs text-muted-foreground">{t("agent.memory.signInNotice")}</p>
  }

  if (state === "loading" && memories.length === 0) {
    return <p className="p-3 text-xs text-muted-foreground">{t("agent.memory.loading")}</p>
  }

  if (state === "error") {
    return (
      <div className="space-y-2 p-3">
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
        <button
          type="button"
          className="text-[11px] underline underline-offset-2"
          onClick={() => void load()}
        >
          {t("common.retry")}
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {error && (
        <p className="border-b bg-destructive/5 px-3 py-1.5 text-[11px] text-destructive" role="alert">
          {error}
        </p>
      )}
      <Tabs defaultValue="proposed" className="flex min-h-0 flex-1 flex-col px-3 py-2">
        <TabsList className="w-fit">
          <TabsTrigger value="proposed" className="gap-1.5">
            {t("agent.memory.tabProposed")}
            {proposed.length > 0 && (
              <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                {proposed.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="approved">{t("agent.memory.tabApproved")}</TabsTrigger>
        </TabsList>

        <TabsContent value="proposed" className="min-h-0 flex-1 overflow-y-auto pt-2">
          <ProposedMemoryList
            memories={proposed}
            roleLevel={roleLevel}
            busyIds={busyMemoryIds}
            onApprove={(m) => reviewMemory(m, "approve")}
            onReject={(m) => reviewMemory(m, "reject")}
          />
        </TabsContent>

        <TabsContent value="approved" className="min-h-0 flex-1 overflow-y-auto pt-2">
          <ApprovedMemoryList
            memories={approved}
            roleLevel={roleLevel}
            username={username}
            onEdit={editMemory}
          />
        </TabsContent>

      </Tabs>

      {supersedePrompt && (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) setSupersedePrompt(null)
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="text-destructive">{t("agent.memory.supersedeTitle")}</DialogTitle>
            </DialogHeader>
            <DialogBody>
              <p className="text-sm">
                <RichMessage
                  k="agent.memory.supersedeBody"
                  values={{ path: <code className="font-mono">{supersedePrompt.path}</code> }}
                />
              </p>
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" onClick={() => setSupersedePrompt(null)}>
                {t("common.cancel")}
              </Button>
              <Button variant="destructive" onClick={confirmSupersede}>
                {t("agent.memory.supersedeConfirm")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
