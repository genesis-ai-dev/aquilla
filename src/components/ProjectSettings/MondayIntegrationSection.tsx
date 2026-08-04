// Project Settings → Integrations → Monday.com.
//
// Contract: monday-integration-contract.md (SPA section). Uses the org's
// Monday connection (managed at /settings/monday); this section links ONE
// board to the project, with an AI-proposed column mapping the user reviews
// and applies, plus a manual mapping editor and a "Sync now" push trigger.
//
// Role gating mirrors TermbaseSharingSection: project-resolved role >=
// MAINTAINER (600) to mutate; any member sees a read-only status summary.
// Board list / structure fetches require ORG maintainer server-side — when
// they 403 we degrade gracefully (raw column ids instead of titles).

import { useCallback, useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { SparkleButton } from "@/components/SparkleButton"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import {
  analyzeMondayMapping,
  deleteMondayLink,
  fetchMondayBoards,
  fetchMondayBoardStructure,
  fetchMondayConnection,
  fetchMondayLink,
  patchMondayLink,
  putMondayLink,
  syncMondayNow,
  type MondayBoard,
  type MondayBoardLink,
  type MondayBoardStructure,
  type MondayConnectionStatus,
} from "@/lib/monday/api"
import type { MondayMapping } from "@/lib/monday/types"
import { MondayMappingTable } from "./MondayMappingEditor"
import { MondayLinkedView } from "./MondayLinkedView"

const MAINTAINER = 600

interface Props {
  projectId: string
  /** The org this project belongs to, or null if not org-owned. */
  orgId: number | null
  /** Caller's resolved role level on this project (AD-12 max-wins). */
  roleLevel: number | null
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function MondayIntegrationSection({ projectId, orgId, roleLevel }: Props) {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const canManage = (roleLevel ?? 0) >= MAINTAINER

  const [connection, setConnection] = useState<MondayConnectionStatus | null>(null)
  const [link, setLink] = useState<MondayBoardLink | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [boards, setBoards] = useState<MondayBoard[] | null>(null)
  const [selectedBoardId, setSelectedBoardId] = useState("")
  const [structure, setStructure] = useState<MondayBoardStructure | null>(null)

  const [proposal, setProposal] = useState<{ proposal: MondayMapping; summary: string } | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [applying, setApplying] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])
  const [reconfigureMsg, setReconfigureMsg] = useState("")

  const [savingMapping, setSavingMapping] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncNotice, setSyncNotice] = useState<string | null>(null)
  const [unlinkOpen, setUnlinkOpen] = useState(false)
  const [unlinking, setUnlinking] = useState(false)

  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // ── Initial load: link status + org connection status ────────────────────
  const load = useCallback(async () => {
    if (!jwt) return
    setLoading(true)
    setError(null)
    try {
      const [linkRes, connRes] = await Promise.all([
        fetchMondayLink(jwt, projectId),
        orgId != null ? fetchMondayConnection(jwt, orgId) : Promise.resolve(null),
      ])
      if (!aliveRef.current) return
      setLink(linkRes.linked && linkRes.link ? linkRes.link : null)
      setConnection(connRes)
    } catch (e) {
      if (aliveRef.current) setError(errMsg(e))
    } finally {
      if (aliveRef.current) setLoading(false)
    }
  }, [jwt, projectId, orgId])

  useEffect(() => {
    void load()
  }, [load])

  const orgConnected = link?.orgConnected ?? connection?.connected ?? false

  // ── Boards list (unlinked, maintainer only) ──────────────────────────────
  useEffect(() => {
    if (!jwt || orgId == null || !canManage || loading || link || !orgConnected) return
    if (boards !== null) return
    let alive = true
    fetchMondayBoards(jwt, orgId)
      .then((got) => {
        if (alive && aliveRef.current) setBoards(got)
      })
      .catch((e: unknown) => {
        if (alive && aliveRef.current) {
          setBoards([])
          setError(errMsg(e))
        }
      })
    return () => {
      alive = false
    }
  }, [jwt, orgId, canManage, loading, link, orgConnected, boards])

  // ── Board structure (selected or linked board) ───────────────────────────
  const structureBoardId = link?.boardId ?? selectedBoardId
  useEffect(() => {
    if (!jwt || orgId == null || !canManage || !structureBoardId) {
      setStructure(null)
      return
    }
    let alive = true
    fetchMondayBoardStructure(jwt, orgId, structureBoardId)
      .then((got) => {
        if (alive && aliveRef.current) setStructure(got)
      })
      .catch(() => {
        // Graceful degradation: tables fall back to raw column ids.
        if (alive && aliveRef.current) setStructure(null)
      })
    return () => {
      alive = false
    }
  }, [jwt, orgId, canManage, structureBoardId])

  // ── AI configure / reconfigure ───────────────────────────────────────────
  const runAnalyze = useCallback(
    async (boardId: string, message?: string, currentConfig?: MondayMapping) => {
      if (!jwt) return
      setAnalyzing(true)
      setError(null)
      try {
        const got = await analyzeMondayMapping(jwt, projectId, {
          boardId,
          ...(message ? { message } : {}),
          ...(currentConfig ? { currentConfig } : {}),
        })
        if (aliveRef.current) setProposal(got)
      } catch (e) {
        if (aliveRef.current) setError(errMsg(e))
      } finally {
        if (aliveRef.current) setAnalyzing(false)
      }
    },
    [jwt, projectId],
  )

  const applyProposal = useCallback(async () => {
    if (!jwt || !proposal) return
    setApplying(true)
    setError(null)
    try {
      if (link) {
        // Reconfigure of an existing link — config-only PATCH.
        const next = await patchMondayLink(jwt, projectId, { config: proposal.proposal })
        if (!aliveRef.current) return
        setLink(next)
        setWarnings([])
      } else {
        const boardId = selectedBoardId
        const boardName = boards?.find((b) => b.id === boardId)?.name
        const out = await putMondayLink(jwt, projectId, {
          boardId,
          ...(boardName ? { boardName } : {}),
          config: proposal.proposal,
        })
        if (!aliveRef.current) return
        setLink(out.link)
        setWarnings(out.warnings)
      }
      setProposal(null)
      setReconfigureMsg("")
    } catch (e) {
      if (aliveRef.current) setError(errMsg(e))
    } finally {
      if (aliveRef.current) setApplying(false)
    }
  }, [jwt, proposal, link, projectId, selectedBoardId, boards])

  // ── Linked-state actions ─────────────────────────────────────────────────
  const handleToggleEnabled = useCallback(
    async (enabled: boolean) => {
      if (!jwt || !link) return
      setToggling(true)
      setError(null)
      try {
        const next = await patchMondayLink(jwt, projectId, { enabled })
        if (aliveRef.current) setLink(next)
      } catch (e) {
        if (aliveRef.current) setError(errMsg(e))
      } finally {
        if (aliveRef.current) setToggling(false)
      }
    },
    [jwt, link, projectId],
  )

  const handleSaveMapping = useCallback(
    async (columns: MondayMapping["columns"]) => {
      if (!jwt || !link) return
      setSavingMapping(true)
      setError(null)
      try {
        const next = await patchMondayLink(jwt, projectId, {
          config: { ...link.config, columns },
        })
        if (aliveRef.current) setLink(next)
      } catch (e) {
        if (aliveRef.current) setError(errMsg(e))
      } finally {
        if (aliveRef.current) setSavingMapping(false)
      }
    },
    [jwt, link, projectId],
  )

  const handleSyncNow = useCallback(async () => {
    if (!jwt) return
    setSyncing(true)
    setSyncNotice(null)
    setError(null)
    try {
      const res = await syncMondayNow(jwt, projectId)
      if (!aliveRef.current) return
      setSyncNotice(
        res.ok
          ? `Pushed to Monday${res.itemsUpserted != null ? ` (${res.itemsUpserted} items)` : ""}.`
          : `Sync failed${res.error ? `: ${res.error}` : ""}.`,
      )
      void load()
    } catch (e) {
      if (aliveRef.current) setSyncNotice(`Sync failed: ${errMsg(e)}`)
    } finally {
      if (aliveRef.current) setSyncing(false)
    }
  }, [jwt, projectId, load])

  const handleUnlink = useCallback(async () => {
    if (!jwt) return
    setUnlinking(true)
    setError(null)
    try {
      await deleteMondayLink(jwt, projectId)
      if (!aliveRef.current) return
      setLink(null)
      setUnlinkOpen(false)
      setBoards(null)
      setSelectedBoardId("")
    } catch (e) {
      if (aliveRef.current) setError(errMsg(e))
    } finally {
      if (aliveRef.current) setUnlinking(false)
    }
  }, [jwt, projectId])

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <Card id="section-monday">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Monday.com
          {link && (
            <Badge variant={link.enabled ? "default" : "secondary"}>
              {link.enabled ? "Sync on" : "Sync paused"}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Loading Monday integration…
          </div>
        ) : !orgConnected ? (
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>Your organization hasn't connected Monday.com yet.</p>
            <p>
              An org maintainer can connect it in{" "}
              <Link to="/settings/monday" className="font-medium text-foreground underline underline-offset-4">
                organization settings
              </Link>
              , or ask an org maintainer to set it up.
            </p>
          </div>
        ) : link ? (
          <MondayLinkedView
            link={link}
            structure={structure}
            canManage={canManage}
            toggling={toggling}
            syncing={syncing}
            syncNotice={syncNotice}
            savingMapping={savingMapping}
            analyzing={analyzing}
            reconfigureMsg={reconfigureMsg}
            onReconfigureMsg={setReconfigureMsg}
            onToggleEnabled={handleToggleEnabled}
            onSyncNow={handleSyncNow}
            onSaveMapping={handleSaveMapping}
            onReconfigure={() => void runAnalyze(link.boardId, reconfigureMsg.trim() || undefined, link.config)}
            onUnlink={() => setUnlinkOpen(true)}
            warnings={warnings}
          />
        ) : !canManage ? (
          <p className="text-sm text-muted-foreground">
            No Monday board is linked to this project. Maintainers can set one up here.
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Link a Monday board to push this project's translation progress automatically.
            </p>
            <div className="flex items-center gap-2">
              <Select
                items={Object.fromEntries((boards ?? []).map((b) => [b.id, b.name]))}
                value={selectedBoardId || null}
                onValueChange={(value) => setSelectedBoardId((value as string) ?? "")}
                disabled={boards === null}
              >
                <SelectTrigger aria-label="Monday board">
                  <SelectValue placeholder={boards === null ? "Loading boards…" : "Pick a board"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {(boards ?? []).map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.name}
                        {b.workspace?.name ? ` — ${b.workspace.name}` : ""}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <span className="flex items-center gap-1 text-sm text-muted-foreground">
                <SparkleButton
                  disabled={!selectedBoardId}
                  loading={analyzing}
                  onComplete={() => void runAnalyze(selectedBoardId)}
                  tooltip="Use AI to configure"
                />
                Use AI to configure
              </span>
            </div>
            {analyzing && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner /> Analyzing the board and this project…
              </p>
            )}
          </div>
        )}

        {proposal && (
          <div className="space-y-3 rounded-lg border p-4" data-testid="monday-proposal-review">
            <p className="text-sm font-medium">AI proposal</p>
            <p className="text-sm text-muted-foreground">{proposal.summary}</p>
            <MondayMappingTable columns={proposal.proposal.columns} structure={structure} />
            {proposal.proposal.notes && (
              <p className="text-xs text-muted-foreground">{proposal.proposal.notes}</p>
            )}
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => void applyProposal()} disabled={applying}>
                {applying && <Spinner data-icon="inline-start" />}
                Apply
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setProposal(null)} disabled={applying}>
                Discard
              </Button>
            </div>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>

      <Dialog open={unlinkOpen} onOpenChange={setUnlinkOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove board link?</DialogTitle>
            <DialogDescription>
              Progress will stop pushing to {link?.boardName ?? "the linked board"}. The board and
              its items are left untouched on Monday.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setUnlinkOpen(false)} disabled={unlinking}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleUnlink} disabled={unlinking}>
              {unlinking && <Spinner data-icon="inline-start" />}
              Remove link
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
