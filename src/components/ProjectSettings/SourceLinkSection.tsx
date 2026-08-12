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
import { DcsUpstreamPanel } from "@/components/dcs/DcsUpstreamPanel"
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
  /** Called after successful detach so the parent can refresh the project record. */
  onDetached: () => void
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
  onDetached,
  roleLevel,
}: SourceLinkSectionProps) {
  const t = useT()
  const { session } = useFrontierSession()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [confirmInput, setConfirmInput] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
            {sourceLinkMode !== "clone" && (
              <Badge variant="outline">{t("projectSettings.sourceLink.cursorLabel", { value: sourceLinkCursor ?? 0 })}</Badge>
            )}
          </div>
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
          <div className="flex justify-end">
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
