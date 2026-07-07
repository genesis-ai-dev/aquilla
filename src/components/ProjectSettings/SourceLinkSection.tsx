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
// FRO-478: extended to also display the link's mode/consumes/gate/cursor
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
import { FRONTIER_API_URL } from "@/lib/sync/sync-token"
import { DcsUpstreamPanel } from "@/components/dcs/DcsUpstreamPanel"

export interface SourceLinkSectionProps {
  projectId: string
  /** Upstream source project id — only show when non-null. */
  sourceProjectId: string
  /** FRO-476/478: link mode — 'clone' | 'live'. Null/undefined ⇒ legacy link
   *  (pre-FRO-476) or unknown — rendered as "live" per the server's own
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
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      setDialogOpen(false)
      setConfirmInput("")
      onDetached()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
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
            Source link
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="text-sm text-muted-foreground">
            This project is linked to an upstream source project.
            Source cells are read from the upstream; translators work on the
            target side here.
          </div>
          <div className="flex items-center gap-2 rounded border px-3 py-2 text-sm">
            <span className="font-medium text-foreground shrink-0">Upstream project ID:</span>
            <code className="flex-1 truncate font-mono text-xs text-muted-foreground">
              {sourceProjectId}
            </code>
          </div>
          {/* FRO-478: mode/consumes/gate/cursor state, read-only — set at
              link/creation time, not editable from here. */}
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <Badge variant={sourceLinkMode === "clone" ? "secondary" : "default"}>
              {sourceLinkMode === "clone" ? "Clone" : "Live"}
            </Badge>
            {sourceLinkConsumes === "target" && (
              <Badge variant="outline">consumes translations</Badge>
            )}
            {sourceLinkConsumes !== "target" && (
              <Badge variant="outline">consumes source</Badge>
            )}
            {sourceLinkConsumes === "target" && sourceLinkGate && (
              <Badge variant="outline">
                gate: {sourceLinkGate === "validated" ? "validated only" : "every commit"}
              </Badge>
            )}
            {sourceLinkMode !== "clone" && (
              <Badge variant="outline">cursor: {sourceLinkCursor ?? 0}</Badge>
            )}
          </div>
          {sourceLinkMode === "clone" && (
            <p className="text-xs text-muted-foreground">
              This is a one-time snapshot — upstream changes do not propagate here.
            </p>
          )}
          {canDetach ? (
            <div className="flex items-start gap-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm dark:border-amber-800 dark:bg-amber-950">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="space-y-1">
                <p className="font-medium text-amber-900 dark:text-amber-100">
                  Detaching is irreversible
                </p>
                <p className="text-amber-800 dark:text-amber-200">
                  Detaching snapshots the current upstream source cells into
                  this project and severs the live link. Stale-source markers
                  will clear. This action cannot be undone.
                </p>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Project lead or above required to detach from source.
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
              Detach from source
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
            <DialogTitle>Detach from source project?</DialogTitle>
            <DialogDescription>
              This will snapshot the upstream source cells into this project and
              permanently sever the link. Stale-source markers will clear. You
              cannot re-attach automatically — a project lead would need to
              re-link manually.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 py-1">
            <p className="text-sm text-muted-foreground">
              Type <span className="font-mono font-bold">DETACH</span> to confirm.
            </p>
            <Input
              value={confirmInput}
              onChange={(e) => setConfirmInput(e.target.value)}
              placeholder="DETACH"
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
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDetach}
              disabled={!confirmed || loading || !session}
            >
              {loading ? "Detaching…" : "Detach"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
