/**
 * AgentMemoryTab.tsx — the "memory" tab in AgentWorkbench (AQU-AGENT
 * contracts §5, owner W1E). Three sections: Proposed queue, Approved list,
 * and the Project brief panel (view/edit + its own proposals sub-list).
 *
 * Data flow: fetches memories (all statuses) + brief + brief proposals once
 * per `projectId`, then applies optimistic status flips locally (revert on a
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
 * `agentSessionStore(projectId).markMemoryReviewed/markBriefReviewed` — the
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
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { agentSessionStore, useAgentSession } from "@/lib/agent/session-store"
import {
  editAgentMemory,
  getProjectBrief,
  listAgentMemories,
  listBriefProposals,
  putProjectBrief,
  reviewAgentMemory,
  reviewBriefProposal,
  SupersedesHumanEditedError,
  VersionConflictError,
  type AgentMemory,
  type ProjectBrief,
  type ProjectBriefProposal,
} from "@/lib/agent/memory-api"
import { ApprovedMemoryList } from "./ApprovedMemoryList"
import { BriefPanel, type StaleProposalInfo } from "./BriefPanel"
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
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const username = session?.username ?? null
  const { state: agentSessionState } = useAgentSession(projectId)

  const [memories, setMemories] = useState<AgentMemory[]>([])
  const [brief, setBrief] = useState<ProjectBrief | null>(null)
  const [briefProposals, setBriefProposals] = useState<ProjectBriefProposal[]>([])
  const [state, setState] = useState<LoadState>("idle")
  const [error, setError] = useState<string | null>(null)
  const [busyMemoryIds, setBusyMemoryIds] = useState<Set<string>>(new Set())
  const [busyProposalIds, setBusyProposalIds] = useState<Set<string>>(new Set())
  const [supersedePrompt, setSupersedePrompt] = useState<SupersedePrompt | null>(null)
  const [staleProposals, setStaleProposals] = useState<Map<string, StaleProposalInfo>>(new Map())

  const load = useCallback(async () => {
    if (!jwt) return
    setState("loading")
    setError(null)
    try {
      const [memoriesResult, briefResult, proposalsResult] = await Promise.all([
        listAgentMemories(jwt, projectId),
        getProjectBrief(jwt, projectId),
        // Best-effort: §3 doesn't explicitly list a GET for proposals — an
        // empty list on a 404 keeps the panel usable rather than failing the
        // whole tab load. See memory-api.ts's SWARM-TODO on this route.
        listBriefProposals(jwt, projectId).catch(() => []),
      ])
      setMemories(memoriesResult)
      setBrief(briefResult)
      setBriefProposals(proposalsResult)
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

  const reloadBrief = useCallback(() => {
    if (!jwt) return
    getProjectBrief(jwt, projectId)
      .then(setBrief)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to reload brief."))
  }, [jwt, projectId])

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
          agentSessionStore(projectId).markMemoryReviewed(updated.id)
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

  const saveBrief = useCallback(
    async (content: string, ifMatchVersion: number) => {
      if (!jwt) throw new Error("Not signed in.")
      const updated = await putProjectBrief(jwt, projectId, content, ifMatchVersion)
      setBrief(updated)
    },
    [jwt, projectId],
  )

  const withBusyProposal = useCallback(async (id: string, fn: () => Promise<void>) => {
    setBusyProposalIds((prev) => new Set(prev).add(id))
    try {
      await fn()
    } finally {
      setBusyProposalIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }, [])

  const reviewProposal = useCallback(
    (proposal: ProjectBriefProposal, action: "approve" | "reject") => {
      if (!jwt) return
      const original = proposal
      // A retried approve on a proposal already marked stale clears the mark
      // optimistically — either the retry succeeds, or the catch re-marks it.
      setStaleProposals((cur) => {
        if (!cur.has(proposal.id)) return cur
        const next = new Map(cur)
        next.delete(proposal.id)
        return next
      })
      // Functional single-id revert (races-F5) — see reviewMemory above.
      setBriefProposals((cur) =>
        cur.map((p) => (p.id === proposal.id ? { ...p, status: action === "approve" ? "approved" : "rejected" } : p)),
      )
      void withBusyProposal(proposal.id, async () => {
        try {
          const updated = await reviewBriefProposal(jwt, projectId, proposal.id, action)
          setBriefProposals((cur) => cur.map((p) => (p.id === updated.id ? updated : p)))
          // mem-M5: flip the matching brief.proposed chat notice, if any.
          agentSessionStore(projectId).markBriefReviewed(updated.id)
          if (action === "approve") reloadBrief()
        } catch (err) {
          setBriefProposals((cur) => cur.map((p) => (p.id === original.id ? original : p)))
          // mem-M3: a stale approve (the brief moved since this was proposed)
          // marks the card in place instead of a generic error banner —
          // Approve stays disabled until the proposal is dropped/re-proposed.
          if (err instanceof VersionConflictError && action === "approve") {
            setStaleProposals((cur) => {
              const next = new Map(cur)
              next.set(proposal.id, { baseVersion: err.baseVersion, currentVersion: err.currentVersion })
              return next
            })
            return
          }
          setError(err instanceof Error ? err.message : "Failed to review brief proposal.")
        }
      })
    },
    [jwt, projectId, withBusyProposal, reloadBrief],
  )

  if (!jwt) {
    return <p className="p-3 text-xs text-muted-foreground">Sign in to view agent memory.</p>
  }

  if (state === "loading" && memories.length === 0 && !brief) {
    return <p className="p-3 text-xs text-muted-foreground">Loading agent memory…</p>
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
          Retry
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
            Proposed
            {proposed.length > 0 && (
              <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                {proposed.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="approved">Approved</TabsTrigger>
          <TabsTrigger value="brief">Project brief</TabsTrigger>
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

        <TabsContent value="brief" className="min-h-0 flex-1 overflow-y-auto pt-2">
          <BriefPanel
            brief={brief}
            proposals={briefProposals}
            roleLevel={roleLevel}
            busyProposalIds={busyProposalIds}
            staleProposals={staleProposals}
            onSaveBrief={saveBrief}
            onReloadBrief={reloadBrief}
            onApproveProposal={(p) => reviewProposal(p, "approve")}
            onRejectProposal={(p) => reviewProposal(p, "reject")}
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
              <DialogTitle className="text-destructive">Replace the human-edited memory?</DialogTitle>
            </DialogHeader>
            <DialogBody>
              <p className="text-sm">
                Approving will replace the human-edited memory at{" "}
                <code className="font-mono">{supersedePrompt.path}</code>. The existing human-authored
                content will be archived.
              </p>
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" onClick={() => setSupersedePrompt(null)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={confirmSupersede}>
                Replace it
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
