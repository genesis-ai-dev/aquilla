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
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import {
  editAgentMemory,
  getProjectBrief,
  listAgentMemories,
  listBriefProposals,
  putProjectBrief,
  reviewAgentMemory,
  reviewBriefProposal,
  type AgentMemory,
  type ProjectBrief,
  type ProjectBriefProposal,
} from "@/lib/agent/memory-api"
import { ApprovedMemoryList } from "./ApprovedMemoryList"
import { BriefPanel } from "./BriefPanel"
import { ProposedMemoryList } from "./ProposedMemoryList"

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

  const [memories, setMemories] = useState<AgentMemory[]>([])
  const [brief, setBrief] = useState<ProjectBrief | null>(null)
  const [briefProposals, setBriefProposals] = useState<ProjectBriefProposal[]>([])
  const [state, setState] = useState<LoadState>("idle")
  const [error, setError] = useState<string | null>(null)
  const [busyMemoryIds, setBusyMemoryIds] = useState<Set<string>>(new Set())
  const [busyProposalIds, setBusyProposalIds] = useState<Set<string>>(new Set())

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
    (memory: AgentMemory, action: "approve" | "reject") => {
      if (!jwt) return
      const prevMemories = memories
      // Optimistic flip; revert to the pre-action snapshot on failure.
      setMemories((cur) =>
        cur.map((m) => (m.id === memory.id ? { ...m, status: action === "approve" ? "approved" : "rejected" } : m)),
      )
      void withBusyMemory(memory.id, async () => {
        try {
          const updated = await reviewAgentMemory(jwt, projectId, memory.id, action)
          setMemories((cur) => cur.map((m) => (m.id === updated.id ? updated : m)))
        } catch (err) {
          setMemories(prevMemories)
          setError(err instanceof Error ? err.message : "Failed to review memory.")
        }
      })
    },
    [jwt, memories, projectId, withBusyMemory],
  )

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
      const prevProposals = briefProposals
      setBriefProposals((cur) =>
        cur.map((p) => (p.id === proposal.id ? { ...p, status: action === "approve" ? "approved" : "rejected" } : p)),
      )
      void withBusyProposal(proposal.id, async () => {
        try {
          const updated = await reviewBriefProposal(jwt, projectId, proposal.id, action)
          setBriefProposals((cur) => cur.map((p) => (p.id === updated.id ? updated : p)))
          if (action === "approve") reloadBrief()
        } catch (err) {
          setBriefProposals(prevProposals)
          setError(err instanceof Error ? err.message : "Failed to review brief proposal.")
        }
      })
    },
    [jwt, briefProposals, projectId, withBusyProposal, reloadBrief],
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
            onSaveBrief={saveBrief}
            onReloadBrief={reloadBrief}
            onApproveProposal={(p) => reviewProposal(p, "approve")}
            onRejectProposal={(p) => reviewProposal(p, "reject")}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
