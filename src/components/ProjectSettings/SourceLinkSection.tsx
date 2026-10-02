// SourceLinkSection — AD-9 "Source link" block in ProjectSettings.
//
// Shows for linked-target projects (sourceProjectId is non-null).
// Provides a detach action with typed confirmation:
//   1. Calls POST /api/v2/projects/:id/detach-source (auth-worker).
//   2. Server emits project.link-source(null) + bursts source.cell.commit
//      snapshots freezing upstream content into this standalone project.
//   3. On success the caller refreshes the project record, which clears
//      sourceProjectId and removes this section from view.
//   4. Stale-source markers are derived from cells.source_event_id vs
//      source event_id pointer; after detach the local source IS the upstream
//      snapshot, so the pointer matches and all markers clear naturally.
//
// AQU-478: extended to also display the link's mode/consumes/gate/cursor
// state (read-only — creation/mode are set at link time, not editable here).
// Detach itself is unchanged.
//
// AQU-1559: the card also says how much of the upstream this link follows —
// "N of M files" for a link made with only some of them picked, "All files" for
// one made with everything checked. The two are different products, not a
// cosmetic difference: a whole-project link keeps receiving the files the
// upstream gains later, a fixed-list one does not, and after a reload the card is
// the only place that distinction is visible.
//
// AQU-1560: a live link also offers "Choose files" to Project Leads — the
// upstream's file list with the followed files locked, to add more of them
// (ChooseLinkedFilesDialog). Not on a clone, which never syncs, nor on a legacy
// link with no recorded mode, which the sync engine does not mirror.
//
// AQU-1544: a live link whose cursor is still 0 has never brought anything
// through. Until this slice it rendered exactly like a healthy one ("Live",
// "cursor: 0"), so a link whose first sync failed was indistinguishable from
// one that worked — for the person who linked it once they had dismissed the
// failure message, and for any teammate opening settings later. It now reads
// "Not synced yet" and carries its own "Sync now".

import { useState } from "react"
import { AlertTriangle, Link2Off } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { toUserFacingError, UserError } from "@/lib/errors/user-error"
import { FRONTIER_API_URL } from "@/lib/sync/sync-token"
import { runLinkSync } from "@/lib/sync/archive"
import { announceProjectRecordChanged } from "@/lib/sync/project-record-changed"
import { clearLinkSeedFailed } from "@/lib/sync/link-seed-status"
import { DcsUpstreamPanel } from "@/components/dcs/DcsUpstreamPanel"
import { ChooseLinkedFilesDialog } from "./ChooseLinkedFilesDialog"
import { useT } from "@/lib/i18n/I18nProvider"
import { RichMessage } from "@/lib/i18n/RichMessage"

export interface SourceLinkSectionProps {
  projectId: string
  /** Upstream source project id — only show when non-null. */
  sourceProjectId: string
  /** AQU-476/478: link mode — 'clone' | 'live'. Null/undefined ⇒ legacy link
   *  (pre-AQU-476) or unknown — rendered as "live" per the server's own
   *  default-to-live-behavior fallback (COALESCE reasoning in stale-source-route.ts). */
  sourceLinkMode?: "clone" | "live" | null
  sourceLinkConsumes?: "source" | "target" | null
  sourceLinkGate?: "head" | "validated" | null
  sourceLinkCursor?: number | null
  /** AQU-1559: the upstream file ids this link follows, or null/undefined for a
   *  whole-project link — which is every link made before that slice, and what
   *  an older server that omits the field means too. */
  sourceLinkFileIds?: string[] | null
  /** AQU-1559: how many files the upstream holds, for the "N of M" the subset
   *  badge states. Null/undefined when the server did not send it (a
   *  whole-project link needs no total), and the badge then states the count
   *  alone rather than inventing a denominator. */
  sourceLinkUpstreamFileCount?: number | null
  /** Called after successful detach so the parent can refresh the project record. */
  onDetached: () => void
  /** AQU-1544: called after a "Sync now" that worked, so the parent can
   *  refresh the project record and pick up the advanced cursor. */
  onSynced?: () => void
  /** AQU-1560: called once files added through "Choose files" are in, so the
   *  parent can refresh the project record (the scope badge, the file list). */
  onFilesAdded?: () => void
  /** The caller's resolved role level on this project. */
  roleLevel: number | null
}

const DETACH_CONFIRM_WORD = "DETACH"
const MIN_ROLE_LEVEL = 500 // project_lead

export function SourceLinkSection({
  projectId,
  sourceProjectId,
  sourceLinkMode,
  sourceLinkConsumes,
  sourceLinkGate,
  sourceLinkCursor,
  sourceLinkFileIds,
  sourceLinkUpstreamFileCount,
  onDetached,
  onSynced,
  onFilesAdded,
  roleLevel,
}: SourceLinkSectionProps) {
  const t = useT()
  const { session } = useFrontierSession()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [confirmInput, setConfirmInput] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [chooseFilesOpen, setChooseFilesOpen] = useState(false)

  // AQU-1544: "idle" until the user presses Sync now. "empty" is a sync that
  // worked and had nothing to bring, which on a never-synced link means the
  // upstream has nothing to give yet — a different sentence from "failed",
  // and the reason the never-synced state cannot simply blame the sync.
  const [syncState, setSyncState] = useState<"idle" | "syncing" | "failed" | "empty">("idle")

  // The cursor is the upstream sequence this link has mirrored up to; the
  // link route resets it to 0 and only a mirror sync that found something
  // advances it. Only an explicit live link qualifies: a clone never syncs
  // after creation, and a legacy link with no recorded mode is badged "Live"
  // above but is not mirrored by the sync engine at all, so "Sync now" would
  // promise something it cannot do.
  const neverSynced = sourceLinkMode === "live" && (sourceLinkCursor ?? 0) === 0

  // AQU-1559: a non-empty list is a link pinned to those upstream files;
  // null/absent/empty is the whole project. `?? followedCount` keeps the badge
  // honest on a server that sends the list without a total — "2 of 2 files" is
  // wrong only if the upstream has more, and saying "All files" there would be a
  // stronger claim than the data supports.
  const followedCount = sourceLinkFileIds?.length ?? 0
  const followsSubset = followedCount > 0

  async function handleSyncNow() {
    if (!session?.jwt || syncState === "syncing") return
    setSyncState("syncing")
    // Never throws: `runLinkSync` folds every failure into `{ ok: false }`.
    const outcome = await runLinkSync(session.jwt, projectId)
    if (!outcome.ok) {
      setSyncState("failed")
      return
    }
    clearLinkSeedFailed(projectId)
    // AQU-1570: content came through, so the page behind this dialog has files
    // to show, not only this card's record.
    if (outcome.ranSync) announceProjectRecordChanged(projectId)
    // Content came through: the refreshed record carries a cursor above 0 and
    // this whole block unmounts. Nothing came through: the upstream is empty,
    // which is said rather than left looking like an unanswered press.
    setSyncState(outcome.ranSync ? "idle" : "empty")
    onSynced?.()
  }

  const canDetach = (roleLevel ?? 0) >= MIN_ROLE_LEVEL
  const confirmed = confirmInput.trim().toUpperCase() === DETACH_CONFIRM_WORD

  async function handleDetach() {
    if (!confirmed || !session?.jwt) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `${FRONTIER_API_URL}/api/v2/projects/${encodeURIComponent(projectId)}/detach-source`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.jwt}`,
          },
        },
      )
      if (!res.ok) {
        // AQU-820: the server's `error` is untranslated and this message is
        // rendered verbatim below — throw the keyed status sentence instead,
        // with the raw body preserved on `.raw`/`.cause`.
        throw new UserError(res.status, await res.text().catch(() => ""), "project")
      }
      setDialogOpen(false)
      setConfirmInput("")
      onDetached()
    } catch (err) {
      setError(toUserFacingError(err, "project").message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      {/* DCS (Door43) freshness/delta — only renders when this project carries a
          `dcsUpstream` cursor (i.e. it is a Door43 adapter project). Self-gated
          inside the panel: readCursor() ⇒ null renders nothing. */}
      <DcsUpstreamPanel projectId={projectId} roleLevel={roleLevel} />
      <Card id="section-source-link">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Link2Off className="h-4 w-4 text-muted-foreground" />
            {t("projectSettings.section.sourceLink")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="text-sm text-muted-foreground">
            {t("projectSettings.sourceLink.description")}
          </div>
          <div className="flex items-center gap-2 rounded border px-3 py-2 text-sm">
            <span className="font-medium text-foreground shrink-0">{t("projectSettings.sourceLink.upstreamIdLabel")}</span>
            <code className="flex-1 truncate font-mono text-xs text-muted-foreground">
              {sourceProjectId}
            </code>
          </div>
          {/* AQU-478: mode/consumes/gate/cursor state, read-only — set at
              link/creation time, not editable from here. */}
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <Badge variant={sourceLinkMode === "clone" ? "secondary" : "default"}>
              {sourceLinkMode === "clone" ? t("projectSettings.sourceLink.modeClone") : t("projectSettings.sourceLink.modeLive")}
            </Badge>
            {sourceLinkConsumes === "target" && (
              <Badge variant="outline">{t("projectSettings.sourceLink.consumesTranslations")}</Badge>
            )}
            {sourceLinkConsumes !== "target" && (
              <Badge variant="outline">{t("projectSettings.sourceLink.consumesSource")}</Badge>
            )}
            {sourceLinkConsumes === "target" && sourceLinkGate && (
              <Badge variant="outline">
                {t("projectSettings.sourceLink.gateLabel", {
                  value: sourceLinkGate === "validated"
                    ? t("projectSettings.sourceLink.gateValidatedOnly")
                    : t("projectSettings.sourceLink.gateEveryCommit"),
                })}
              </Badge>
            )}
            <Badge variant="outline">
              {followsSubset
                ? t("projectSettings.sourceLink.scopeSomeFiles", {
                    count: followedCount,
                    total: sourceLinkUpstreamFileCount ?? followedCount,
                  })
                : t("projectSettings.sourceLink.scopeAllFiles")}
            </Badge>
            {sourceLinkMode !== "clone" && !neverSynced && (
              <Badge variant="outline">{t("projectSettings.sourceLink.cursorLabel", { value: sourceLinkCursor ?? 0 })}</Badge>
            )}
            {neverSynced && (
              <Badge
                variant="outline"
                className="border-amber-400 text-amber-900 dark:border-amber-600 dark:text-amber-200"
              >
                {t("projectSettings.sourceLink.notSyncedBadge")}
              </Badge>
            )}
          </div>
          {neverSynced && (
            <div className="flex items-start justify-between gap-3 rounded border px-3 py-2 text-sm">
              <p role={syncState === "failed" ? "alert" : "status"}>
                {syncState === "failed"
                  ? t("projectSettings.sourceLink.syncFailedNote")
                  : syncState === "empty"
                    ? t("projectSettings.sourceLink.syncNothingYetNote")
                    : t("projectSettings.sourceLink.notSyncedNote")}
              </p>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                disabled={syncState === "syncing" || !session}
                onClick={() => void handleSyncNow()}
              >
                {syncState === "syncing"
                  ? t("projectSettings.sourceLink.syncingButton")
                  : t("projectSettings.sourceLink.syncNowButton")}
              </Button>
            </div>
          )}
          {sourceLinkMode === "clone" && (
            <p className="text-xs text-muted-foreground">
              {t("projectSettings.sourceLink.cloneNote")}
            </p>
          )}
          {canDetach ? (
            <div className="flex items-start gap-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm dark:border-amber-800 dark:bg-amber-950">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="space-y-1">
                <p className="font-medium text-amber-900 dark:text-amber-100">
                  {t("projectSettings.sourceLink.irreversibleTitle")}
                </p>
                <p className="text-amber-800 dark:text-amber-200">
                  {t("projectSettings.sourceLink.irreversibleDescription")}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("projectSettings.sourceLink.roleGateNote")}
            </p>
          )}
          <div className="flex justify-end gap-2">
            {/* AQU-1560: same role floor as detach (project_lead), and shown
                disabled below it the same way — the server refuses it too. */}
            {sourceLinkMode === "live" && (
              <Button
                variant="outline"
                size="sm"
                disabled={!canDetach || !session}
                onClick={() => setChooseFilesOpen(true)}
              >
                {t("projectSettings.sourceLink.chooseFilesButton")}
              </Button>
            )}
            <Button
              variant="destructive"
              size="sm"
              disabled={!canDetach || !session}
              onClick={() => {
                setConfirmInput("")
                setError(null)
                setDialogOpen(true)
              }}
            >
              {t("projectSettings.sourceLink.detachButton")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {sourceLinkMode === "live" && canDetach && (
        <ChooseLinkedFilesDialog
          projectId={projectId}
          sourceProjectId={sourceProjectId}
          followedFileIds={sourceLinkFileIds}
          open={chooseFilesOpen}
          onOpenChange={setChooseFilesOpen}
          onAdded={() => onFilesAdded?.()}
        />
      )}

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!loading) {
            setDialogOpen(open)
            if (!open) setConfirmInput("")
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("projectSettings.sourceLink.detachDialogTitle")}</DialogTitle>
            <DialogDescription>
              {t("projectSettings.sourceLink.detachDialogDescription")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 py-1">
            <p className="text-sm text-muted-foreground">
              <RichMessage
                k="projectSettings.sourceLink.typeToConfirm"
                values={{ word: <span className="font-mono font-bold">{DETACH_CONFIRM_WORD}</span> }}
              />
            </p>
            <Input
              value={confirmInput}
              onChange={(e) => setConfirmInput(e.target.value)}
              placeholder={DETACH_CONFIRM_WORD}
              disabled={loading}
              autoFocus
            />
            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setDialogOpen(false)
                setConfirmInput("")
              }}
              disabled={loading}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDetach}
              disabled={!confirmed || loading || !session}
            >
              {loading ? t("projectSettings.sourceLink.detachingButton") : t("projectSettings.sourceLink.detachConfirmButton")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
