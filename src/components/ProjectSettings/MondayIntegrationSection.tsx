// Project Settings → Integrations → Monday.com.
//
// Contract: docs/MONDAY-INTEGRATION.md. Uses the org's Monday connection
// (managed at /orgs/:orgId/settings/monday); this section links ONE
// board to the project, with an AI-proposed column mapping the user reviews
// and applies, plus a manual mapping editor and a "Sync now" push trigger.
//
// Role gating mirrors TermbaseSharingSection: project-resolved role >=
// MAINTAINER (600) to mutate; any member sees a read-only status summary.
// Board list / structure fetches require ORG maintainer server-side — when
// they 403 we degrade gracefully (raw column ids instead of titles).
//
// SWARM-TODO(AQU-832, i18n): this file plus MondayLinkedView.tsx and
// MondayMappingEditor.tsx (~50 unkeyed strings total) are deliberately left
// unkeyed by the WS-14 project-settings/creation/sharing i18n wave — the
// audit scoped the Monday.com integration trio to a later wave rather than
// this pass. Key with a `projectSettings.monday.*` (or dedicated `monday`)
// namespace when that wave starts; see docs/swarm/TRACES.md.

import { useCallback, useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { Columns3, Sparkles } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { SettingsGroup, SettingsRow } from "@/components/ui/page"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import {
  analyzeMondayMapping,
  deleteMondayLink,
  fetchMondayConnection,
  fetchMondayLink,
  patchMondayLink,
  syncMondayNow,
  type MondayBoardLink,
  type MondayConnectionStatus,
  type MondaySyncResult,
} from "@/lib/monday/api"
import type { MondayMapping } from "@/lib/monday/types"
import { MondayMappingTable } from "./MondayMappingEditor"
import { MondayLinkedView } from "./MondayLinkedView"
import { useMondayBoardChanges, type MondayNewColumn } from "./useMondayBoardChanges"
import { MondaySetupWizard } from "./MondaySetupWizard"
import { MondayAddColumnsDialog } from "./MondayAddColumnsDialog"
import { useT } from "@/lib/i18n/I18nProvider"

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

function syncNoticeText(res: MondaySyncResult): string {
  const items = res.itemsUpserted
  return res.ok
    ? `Pushed to Monday${items != null ? ` (${items} ${items === 1 ? "item" : "items"})` : ""}.`
    : `Sync failed${res.error ? `: ${res.error}` : ""}.`
}

export function MondayIntegrationSection({ projectId, orgId, roleLevel }: Props) {
  const t = useT()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const canManage = (roleLevel ?? 0) >= MAINTAINER

  const [connection, setConnection] = useState<MondayConnectionStatus | null>(null)
  const [link, setLink] = useState<MondayBoardLink | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [projectConnected, setProjectConnected] = useState<boolean | undefined>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // The board's columns now, and which are new since the link was saved.
  const markStale = useCallback(
    (stale: boolean) => setLink((l) => (l && l.structureStale !== stale ? { ...l, structureStale: stale } : l)),
    [],
  )
  const board = useMondayBoardChanges({
    jwt,
    projectId,
    orgId,
    boardId: link?.boardId ?? "",
    enabled: canManage,
    onStaleChange: markStale,
  })
  const { structure, newColumns, refresh: refreshBoard, dismiss: dismissBoardColumns } = board
  /** "Map it" on a new column: a row for it appears in the mapping editor. */
  const [requestedRow, setRequestedRow] = useState<{ column: MondayNewColumn; nonce: number } | null>(null)

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
  const [wizardOpen, setWizardOpen] = useState(false)
  /** The same setup steps, without the AI — the escape hatch under "Set up with AI". */
  const [wizardMode, setWizardMode] = useState<"ai" | "manual">("ai")
  const [addColumnsOpen, setAddColumnsOpen] = useState(false)

  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // ── Initial load: link status + org connection status ────────────────────
  // The spinner is for the first load only. A refresh (coming back to the
  // tab, after Sync now) keeps the page as it is, so the mapping editor and
  // any rows not yet saved stay put while the new data loads.
  const loadedOnceRef = useRef(false)
  const load = useCallback(async () => {
    if (!jwt) return
    if (!loadedOnceRef.current) setLoading(true)
    setStatusError(null)
    setError(null)
    try {
      const [linkRes, connRes] = await Promise.all([
        fetchMondayLink(jwt, projectId),
        orgId != null ? fetchMondayConnection(jwt, orgId).catch(() => null) : Promise.resolve(null),
      ])
      if (!aliveRef.current) return
      setLink(linkRes.linked && linkRes.link ? linkRes.link : null)
      // Re-read the board too, so columns added on Monday since show up.
      refreshBoard()
      setConnection(connRes)
      setProjectConnected(linkRes.orgConnected ?? linkRes.link?.orgConnected)
      if (linkRes.orgConnected == null && !linkRes.link && !connRes) {
        setStatusError(t("projectSettings.monday.connectionCheckFailed"))
      }
    } catch (e) {
      if (aliveRef.current) setStatusError(errMsg(e))
    } finally {
      if (aliveRef.current) {
        loadedOnceRef.current = true
        setLoading(false)
      }
    }
  }, [jwt, projectId, orgId, t, refreshBoard])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const refresh = () => void load()
    window.addEventListener("focus", refresh)
    return () => window.removeEventListener("focus", refresh)
  }, [load])

  const orgConnected = projectConnected ?? link?.orgConnected ?? connection?.connected ?? false


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
    if (!jwt || !proposal || !link) return
    setApplying(true)
    setError(null)
    try {
      // Reconfigure of an existing link — config-only PATCH.
      const next = await patchMondayLink(jwt, projectId, { config: proposal.proposal })
      if (!aliveRef.current) return
      setLink(next.link)
      setWarnings(next.warnings)
      setProposal(null)
      setReconfigureMsg("")
    } catch (e) {
      if (aliveRef.current) setError(errMsg(e))
    } finally {
      if (aliveRef.current) setApplying(false)
    }
  }, [jwt, proposal, link, projectId])

  // ── Linked-state actions ─────────────────────────────────────────────────
  const handleToggleEnabled = useCallback(
    async (enabled: boolean) => {
      if (!jwt || !link) return
      setToggling(true)
      setError(null)
      try {
        setSyncNotice(null)
        const next = await patchMondayLink(jwt, projectId, { enabled })
        if (!aliveRef.current) return
        setLink(next.link)
        // Turning Sync back on pushes straight away; say how it went.
        if (next.push) setSyncNotice(syncNoticeText(next.push))
      } catch (e) {
        if (aliveRef.current) setError(errMsg(e))
      } finally {
        if (aliveRef.current) setToggling(false)
      }
    },
    [jwt, link, projectId],
  )

  const handleSaveMapping = useCallback(
    async (columns: MondayMapping["columns"]): Promise<boolean> => {
      if (!jwt || !link) return false
      setSavingMapping(true)
      setError(null)
      try {
        const next = await patchMondayLink(jwt, projectId, {
          config: { ...link.config, columns },
        })
        if (!aliveRef.current) return false
        setLink(next.link)
        // Columns the board doesn't have are dropped server-side; say which.
        setWarnings(next.warnings)
        // Saving re-reads the board and clears "Board structure changed".
        refreshBoard()
        return true
      } catch (e) {
        if (aliveRef.current) setError(errMsg(e))
        return false
      } finally {
        if (aliveRef.current) setSavingMapping(false)
      }
    },
    [jwt, link, projectId, refreshBoard],
  )

  const handleDismissColumn = useCallback(
    async (columnId: string) => {
      setError(null)
      try {
        await dismissBoardColumns([columnId])
      } catch (e) {
        if (aliveRef.current) setError(errMsg(e))
      }
    },
    [dismissBoardColumns],
  )

  const handleSyncNow = useCallback(async () => {
    if (!jwt) return
    setSyncing(true)
    setSyncNotice(null)
    setError(null)
    try {
      const res = await syncMondayNow(jwt, projectId)
      if (!aliveRef.current) return
      setSyncNotice(syncNoticeText(res))
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
    } catch (e) {
      if (aliveRef.current) setError(errMsg(e))
    } finally {
      if (aliveRef.current) setUnlinking(false)
    }
  }, [jwt, projectId])

  // ── Render ───────────────────────────────────────────────────────────────
  const orgSettingsLinkLabel = t("projectSettings.monday.orgSettingsLinkText")
  const connectInstructions = t("projectSettings.monday.orgNotConnectedInstructions", {
    settingsLink: orgSettingsLinkLabel,
  })
  const [connectInstructionsBefore, connectInstructionsAfter] =
    connectInstructions.split(orgSettingsLinkLabel)

  return (
    <div id="section-monday">
      <SettingsGroup
        label={
          <span className="inline-flex items-center gap-2">
            Monday.com
            {link ? (
              <Badge variant={link.enabled ? "default" : "secondary"}>
                {link.enabled ? "Sync on" : "Sync paused"}
              </Badge>
            ) : null}
          </span>
        }
      >
        <SettingsRow label={t("projectSettings.monday.boardSyncLabel")} block>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> {t("projectSettings.monday.loadingIntegration")}
            </div>
          ) : statusError ? (
            <div role="alert" className="flex flex-col gap-2">
              <p>{statusError}</p>
              <Button variant="outline" onClick={() => void load()}>{t("projectSettings.monday.retryAction")}</Button>
            </div>
          ) : !orgConnected && !canManage ? (
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>{t("projectSettings.monday.orgNotConnected")}</p>
              <p>
                {connectInstructionsBefore}
                {orgId != null ? (
                  <Link
                    to={`/orgs/${orgId}/settings/monday`}
                    className="font-medium text-foreground underline underline-offset-4"
                  >
                    {orgSettingsLinkLabel}
                  </Link>
                ) : (
                  orgSettingsLinkLabel
                )}
                {connectInstructionsAfter}
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
              newColumns={newColumns}
              checkingBoard={board.checking}
              structureLoading={board.structureLoading}
              requestedRow={requestedRow}
              onMapColumn={(column) => setRequestedRow((r) => ({ column, nonce: (r?.nonce ?? 0) + 1 }))}
              onDismissColumn={(columnId) => void handleDismissColumn(columnId)}
              onReconfigure={() => void runAnalyze(link.boardId, reconfigureMsg.trim() || undefined, link.config)}
              onUnlink={() => setUnlinkOpen(true)}
              warnings={warnings}
              missingColumns={
                canManage ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setAddColumnsOpen(true)}
                    disabled={savingMapping}
                    data-testid="monday-add-columns"
                  >
                    <Columns3 data-icon="inline-start" />
                    {t("projectSettings.monday.addColumnsButton")}
                  </Button>
                ) : null
              }
            />
          ) : !canManage ? (
            <p className="text-sm text-muted-foreground">
              {t("projectSettings.monday.noBoardLinkedReadOnly")}
            </p>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {t("projectSettings.monday.linkBoardPrompt")}
              </p>
              <Button
                onClick={() => {
                  setWizardMode("ai")
                  setWizardOpen(true)
                }}
                data-testid="monday-setup-with-ai"
              >
                <Sparkles data-icon="inline-start" />
                {t("projectSettings.monday.setupWithAiButton")}
              </Button>
              <p className="text-xs text-muted-foreground">
                {t("projectSettings.monday.setupWithAiBlurb")}
              </p>
              {/* The same steps without the AI, kept as an escape hatch. Hidden
                  until the org is connected — without a token it can only ever
                  show an empty board picker. */}
              {orgConnected && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setWizardMode("manual")
                    setWizardOpen(true)
                  }}
                >
                  {t("projectSettings.monday.setupManuallyButton")}
                </Button>
              )}
              {analyzing && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner /> {t("projectSettings.monday.analyzingBoardAndProject")}
                </p>
              )}
            </div>
          )}

          {proposal && (
            <div className="mt-3 space-y-3 rounded-lg border bg-background p-4" data-testid="monday-proposal-review">
              <p className="text-sm font-medium">{t("projectSettings.monday.aiProposalLabel")}</p>
              <p className="text-sm text-muted-foreground">{proposal.summary}</p>
              <MondayMappingTable columns={proposal.proposal.columns} structure={structure} />
              {proposal.proposal.notes && (
                <p className="text-xs text-muted-foreground">{proposal.proposal.notes}</p>
              )}
              <div className="flex items-center gap-2">
                <Button onClick={() => void applyProposal()} disabled={applying}>
                  {applying && <Spinner data-icon="inline-start" />}
                  {t("projectSettings.monday.applyButton")}
                </Button>
                <Button variant="ghost" onClick={() => setProposal(null)} disabled={applying}>
                  {t("common.discard")}
                </Button>
              </div>
            </div>
          )}

          {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
        </SettingsRow>
      </SettingsGroup>

      <MondaySetupWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        projectId={projectId}
        orgId={orgId}
        jwt={jwt}
        orgConnected={orgConnected}
        mode={wizardMode}
        onLinked={(next, linkWarnings) => {
          setLink(next)
          setWarnings(linkWarnings)
        }}
        onUnlinked={() => setLink(null)}
        onConnected={() => void load()}
      />

      {link && (
        <MondayAddColumnsDialog
          open={addColumnsOpen}
          onOpenChange={setAddColumnsOpen}
          jwt={jwt}
          projectId={projectId}
          boardId={link.boardId}
          boardName={link.boardName ?? link.boardId}
          rows={link.config.columns}
          boardColumns={structure?.columns}
          onSave={(columns) => handleSaveMapping(columns)}
        />
      )}

      <Dialog open={unlinkOpen} onOpenChange={setUnlinkOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("projectSettings.monday.removeBoardLinkTitle")}</DialogTitle>
            <DialogDescription>
              {t("projectSettings.monday.removeBoardLinkDescription", {
                boardName: link?.boardName ?? "the linked board",
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setUnlinkOpen(false)} disabled={unlinking}>
              {t("common.cancel")}
            </Button>
            <Button variant="destructive" onClick={handleUnlink} disabled={unlinking}>
              {unlinking && <Spinner data-icon="inline-start" />}
              {t("projectSettings.monday.removeLinkButton")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
