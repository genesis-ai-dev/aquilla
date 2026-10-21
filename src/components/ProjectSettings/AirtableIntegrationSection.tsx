// Project Settings → Integrations → Airtable (AQU-804).
//
// Monday's section (MondayIntegrationSection) for an Airtable table: it uses
// the org's Airtable connection (a personal access token pasted in Org
// settings → Airtable, or in this section's setup) and links ONE table to the
// project, with an AI-proposed field mapping the user reviews, the manual
// mapping editor, "Add fields" and "Sync now". The linked view, mapping
// editor and field picker are Monday's components with Airtable's field
// types and words.
//
// Role gating as Monday's: project maintainer (600) to change anything; any
// member sees a read-only summary. Reading the table's fields needs the org's
// token server-side, so a failure there degrades to the saved mapping.

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
  addAirtableFields,
  analyzeAirtableMapping,
  deleteAirtableLink,
  fetchAirtableConnection,
  fetchAirtableLink,
  patchAirtableLink,
  syncAirtableNow,
  type AirtableConnectionStatus,
  type AirtableSyncResult,
  type AirtableTableLink,
} from "@/lib/airtable/api"
import { AIRTABLE_COLUMN_PROFILE, type AirtableMapping } from "@/lib/airtable/types"
import { AIRTABLE_TABLE_CHANGES_SOURCE } from "@/lib/airtable/table-changes"
import {
  AIRTABLE_ADD_COLUMNS_COPY,
  AIRTABLE_CHOOSER_COPY,
  AIRTABLE_LINKED_VIEW_COPY,
  AIRTABLE_MAPPING_COPY,
} from "@/lib/airtable/ui-copy"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { useT } from "@/lib/i18n/I18nProvider"
import { MondayMappingTable } from "./MondayMappingEditor"
import { MondayLinkedView } from "./MondayLinkedView"
import { useMondayBoardChanges, type MondayNewColumn } from "./useMondayBoardChanges"
import { MondayAddColumnsDialog } from "./MondayAddColumnsDialog"
import { AirtableSetupWizard } from "./AirtableSetupWizard"

const MAINTAINER = 600

/** The "one record per …" line under the linked table's name. */
const RECORDS_LINE: Record<AirtableMapping["itemGranularity"], MessageKey> = {
  project: "projectSettings.airtable.recordsLine.project",
  file: "projectSettings.airtable.recordsLine.file",
  project_and_files: "projectSettings.airtable.recordsLine.projectAndFiles",
}

interface Props {
  projectId: string
  /** The org this project belongs to, or null if not org-owned. */
  orgId: number | null
  /** Caller's resolved role level on this project. */
  roleLevel: number | null
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function AirtableIntegrationSection({ projectId, orgId, roleLevel }: Props) {
  const t = useT()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const canManage = (roleLevel ?? 0) >= MAINTAINER

  const [connection, setConnection] = useState<AirtableConnectionStatus | null>(null)
  const [link, setLink] = useState<AirtableTableLink | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [projectConnected, setProjectConnected] = useState<boolean | undefined>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // The table's fields now, and which are new since the link was saved.
  const markStale = useCallback(
    (stale: boolean) => setLink((l) => (l && l.structureStale !== stale ? { ...l, structureStale: stale } : l)),
    [],
  )
  const table = useMondayBoardChanges({
    jwt,
    projectId,
    orgId,
    boardId: link?.tableId ?? "",
    enabled: canManage,
    onStaleChange: markStale,
    source: AIRTABLE_TABLE_CHANGES_SOURCE,
  })
  const { structure, newColumns, refresh: refreshTable, dismiss: dismissFields } = table
  const [requestedRow, setRequestedRow] = useState<{ column: MondayNewColumn; nonce: number } | null>(null)

  const [proposal, setProposal] = useState<{ proposal: AirtableMapping; summary: string } | null>(null)
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
  const [wizardMode, setWizardMode] = useState<"ai" | "manual">("ai")
  const [addFieldsOpen, setAddFieldsOpen] = useState(false)

  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const syncNoticeText = useCallback(
    (res: AirtableSyncResult) =>
      res.ok
        ? t("projectSettings.airtable.pushedNotice", { count: res.itemsUpserted ?? 0 })
        : t("projectSettings.airtable.syncFailedNotice", { reason: res.error ?? "" }),
    [t],
  )

  // The spinner is for the first load only; a refresh keeps the page as it is.
  const loadedOnceRef = useRef(false)
  const load = useCallback(async () => {
    if (!jwt) return
    if (!loadedOnceRef.current) setLoading(true)
    setStatusError(null)
    setError(null)
    try {
      const [linkRes, connRes] = await Promise.all([
        fetchAirtableLink(jwt, projectId),
        orgId != null ? fetchAirtableConnection(jwt, orgId).catch(() => null) : Promise.resolve(null),
      ])
      if (!aliveRef.current) return
      setLink(linkRes.linked && linkRes.link ? linkRes.link : null)
      // Re-read the table too, so fields added in Airtable since show up.
      refreshTable()
      setConnection(connRes)
      setProjectConnected(linkRes.orgConnected ?? linkRes.link?.orgConnected)
      if (linkRes.orgConnected == null && !linkRes.link && !connRes) {
        setStatusError(t("projectSettings.airtable.connectionCheckFailed"))
      }
    } catch (e) {
      if (aliveRef.current) setStatusError(errMsg(e))
    } finally {
      if (aliveRef.current) {
        loadedOnceRef.current = true
        setLoading(false)
      }
    }
  }, [jwt, projectId, orgId, t, refreshTable])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const refresh = () => void load()
    window.addEventListener("focus", refresh)
    return () => window.removeEventListener("focus", refresh)
  }, [load])

  const orgConnected = projectConnected ?? link?.orgConnected ?? connection?.connected ?? false

  // ── Reconfigure with AI ──────────────────────────────────────────────────
  const runAnalyze = useCallback(
    async (current: AirtableTableLink, message?: string) => {
      if (!jwt) return
      setAnalyzing(true)
      setError(null)
      try {
        const got = await analyzeAirtableMapping(jwt, projectId, {
          baseId: current.baseId,
          tableId: current.tableId,
          ...(message ? { message } : {}),
          currentConfig: current.config,
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
      const next = await patchAirtableLink(jwt, projectId, { config: proposal.proposal })
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
        const next = await patchAirtableLink(jwt, projectId, { enabled })
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
    [jwt, link, projectId, syncNoticeText],
  )

  const handleSaveMapping = useCallback(
    async (columns: AirtableMapping["columns"]): Promise<boolean> => {
      if (!jwt || !link) return false
      setSavingMapping(true)
      setError(null)
      try {
        const next = await patchAirtableLink(jwt, projectId, { config: { ...link.config, columns } })
        if (!aliveRef.current) return false
        setLink(next.link)
        setWarnings(next.warnings)
        refreshTable()
        return true
      } catch (e) {
        if (aliveRef.current) setError(errMsg(e))
        return false
      } finally {
        if (aliveRef.current) setSavingMapping(false)
      }
    },
    [jwt, link, projectId, refreshTable],
  )

  const handleDismissField = useCallback(
    async (fieldId: string) => {
      setError(null)
      try {
        await dismissFields([fieldId])
      } catch (e) {
        if (aliveRef.current) setError(errMsg(e))
      }
    },
    [dismissFields],
  )

  const handleSyncNow = useCallback(async () => {
    if (!jwt) return
    setSyncing(true)
    setSyncNotice(null)
    setError(null)
    try {
      const res = await syncAirtableNow(jwt, projectId)
      if (!aliveRef.current) return
      setSyncNotice(syncNoticeText(res))
      void load()
    } catch (e) {
      if (aliveRef.current) setSyncNotice(t("projectSettings.airtable.syncFailedNotice", { reason: errMsg(e) }))
    } finally {
      if (aliveRef.current) setSyncing(false)
    }
  }, [jwt, projectId, load, syncNoticeText, t])

  const handleUnlink = useCallback(async () => {
    if (!jwt) return
    setUnlinking(true)
    setError(null)
    try {
      await deleteAirtableLink(jwt, projectId)
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
  const [connectInstructionsBefore, connectInstructionsAfter] = connectInstructions.split(orgSettingsLinkLabel)

  return (
    <div id="section-airtable">
      <SettingsGroup
        label={
          <span className="inline-flex items-center gap-2">
            Airtable
            {link ? (
              <Badge variant={link.enabled ? "default" : "secondary"}>
                {link.enabled ? t("projectSettings.airtable.syncOnBadge") : t("projectSettings.monday.orgProjectSyncPaused")}
              </Badge>
            ) : null}
          </span>
        }
      >
        <SettingsRow label={t("projectSettings.airtable.tableSyncLabel")} block>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> {t("projectSettings.airtable.loadingIntegration")}
            </div>
          ) : statusError ? (
            <div role="alert" className="flex flex-col gap-2">
              <p>{statusError}</p>
              <Button variant="outline" onClick={() => void load()}>
                {t("projectSettings.monday.retryAction")}
              </Button>
            </div>
          ) : !orgConnected && !canManage ? (
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>{t("projectSettings.airtable.orgNotConnected")}</p>
              <p>
                {connectInstructionsBefore}
                {orgId != null ? (
                  <Link
                    to={`/orgs/${orgId}/settings/airtable`}
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
              checkingBoard={table.checking}
              structureLoading={table.structureLoading}
              requestedRow={requestedRow}
              onMapColumn={(column) => setRequestedRow((r) => ({ column, nonce: (r?.nonce ?? 0) + 1 }))}
              onDismissColumn={(fieldId) => void handleDismissField(fieldId)}
              onReconfigure={() => void runAnalyze(link, reconfigureMsg.trim() || undefined)}
              onUnlink={() => setUnlinkOpen(true)}
              warnings={warnings}
              target={{ name: link.tableName ?? link.tableId, url: link.tableUrl }}
              granularityLabel={t(RECORDS_LINE[link.config.itemGranularity] ?? RECORDS_LINE.project)}
              copy={AIRTABLE_LINKED_VIEW_COPY}
              mappingCopy={AIRTABLE_MAPPING_COPY}
              profile={AIRTABLE_COLUMN_PROFILE}
              idPrefix="airtable"
              missingColumns={
                canManage ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setAddFieldsOpen(true)}
                    disabled={savingMapping}
                    data-testid="airtable-add-fields"
                  >
                    <Columns3 data-icon="inline-start" />
                    {t("projectSettings.airtable.addFieldsButton")}
                  </Button>
                ) : null
              }
            />
          ) : !canManage ? (
            <p className="text-sm text-muted-foreground">{t("projectSettings.airtable.noTableLinkedReadOnly")}</p>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">{t("projectSettings.airtable.linkTablePrompt")}</p>
              <Button
                onClick={() => {
                  setWizardMode("ai")
                  setWizardOpen(true)
                }}
                data-testid="airtable-setup-with-ai"
              >
                <Sparkles data-icon="inline-start" />
                {t("projectSettings.monday.setupWithAiButton")}
              </Button>
              <p className="text-xs text-muted-foreground">{t("projectSettings.airtable.setupWithAiBlurb")}</p>
              {/* The same steps without the AI, as on Monday. */}
              <Button
                variant="ghost"
                onClick={() => {
                  setWizardMode("manual")
                  setWizardOpen(true)
                }}
              >
                {t("projectSettings.monday.setupManuallyButton")}
              </Button>
            </div>
          )}

          {proposal && (
            <div className="mt-3 space-y-3 rounded-lg border bg-background p-4" data-testid="airtable-proposal-review">
              <p className="text-sm font-medium">{t("projectSettings.monday.aiProposalLabel")}</p>
              <p className="text-sm text-muted-foreground">{proposal.summary}</p>
              <MondayMappingTable columns={proposal.proposal.columns} structure={structure} copy={AIRTABLE_MAPPING_COPY} />
              {proposal.proposal.notes && <p className="text-xs text-muted-foreground">{proposal.proposal.notes}</p>}
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

      <AirtableSetupWizard
        open={wizardOpen}
        onOpenChange={(open) => {
          setWizardOpen(open)
          // The wizard links, then pushes: re-read the link so its last push shows.
          if (!open) void load()
        }}
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
          open={addFieldsOpen}
          onOpenChange={setAddFieldsOpen}
          jwt={jwt}
          projectId={projectId}
          boardId={link.tableId}
          boardName={link.tableName ?? link.tableId}
          rows={link.config.columns}
          boardColumns={structure?.columns}
          onSave={(columns) => handleSaveMapping(columns)}
          addColumns={(metrics) =>
            addAirtableFields(jwt ?? "", projectId, { baseId: link.baseId, tableId: link.tableId, metrics })
          }
          profile={AIRTABLE_COLUMN_PROFILE}
          copy={AIRTABLE_ADD_COLUMNS_COPY}
          chooserCopy={AIRTABLE_CHOOSER_COPY}
          testIdPrefix="airtable"
        />
      )}

      <Dialog open={unlinkOpen} onOpenChange={setUnlinkOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("projectSettings.airtable.removeTableLinkTitle")}</DialogTitle>
            <DialogDescription>
              {t("projectSettings.airtable.removeTableLinkDescription", {
                table: link?.tableName ?? link?.tableId ?? "",
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
