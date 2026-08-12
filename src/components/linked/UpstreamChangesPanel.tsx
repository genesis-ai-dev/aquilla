// AQU-478: "Upstream changes" review panel.
//
// Per-project surface listing cells flagged by the AQU-476 mirror engine —
// direct-stale + tombstoned — grouped by mirror-sync batch, with an old→new
// diff and per-cell / bulk actions:
//   - Open to retranslate: navigates to the cell in the editor.
//   - Accept as-is (repin): emits target.cell.repin (reviewer 300+ single;
//     project_lead 500+ for bulk). Does not move the chain head; validation
//     state is untouched by design (spec §7).
//
// Role gating (spec §12): viewer(100)+ can see the panel (read-only);
// reviewer(300)+ can repin one cell at a time; project_lead(500)+ can
// bulk-repin a selection.
//
// SWARM-TODO(AQU-478): live-UI walk once AQU-476 is deployed to a dev stack —
//   1. Seed A (upstream) → B (downstream) via POST /api/v2/projects/:B/link-source
//      { sourceProjectId: A, mode: 'live' }; translate a few cells in B.
//   2. Edit several source cells in A (source.cell.commit); trigger
//      POST /api/v1/projects/:B/link/sync (or just open a file in B — the
//      lazy-pull trigger in useStaleSourceCells fires it).
//   3. Open Project Settings → "Upstream changes" section in B (only
//      visible for a live-linked project — self-contained/clone projects
//      never show it). Confirm the flagged cells render grouped by sync
//      batch with a readable word-diff.
//   4. Click "Open" on one row → confirm it navigates to
//      /project/:B/editor/file/:fileId?cellId=:cellId and the editor scrolls there.
//   5. As a reviewer(300) role, click "Accept as-is" on one cell → confirm
//      the row disappears from the flagged list on revalidate and the
//      cell's stale badge clears; re-open the cell's edit history and
//      confirm `validated`/endorsements are untouched.
//   6. As project_lead(500), select several rows via checkbox → "Accept
//      as-is (N)" → confirm bulk repin clears all selected, and that a
//      concurrently-retranslated cell (re-commit it in another tab mid-bulk)
//      shows the "skipped — retranslated since" badge instead of clobbering.
//   7. As a contributor(400) role, confirm the panel is visible but every
//      Accept-as-is button is disabled and no checkboxes render (bulk needs
//      500+, single-repin needs 300+ — contributor is below both).

import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { AlertTriangle, ArrowRight, CheckCheck, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Spinner } from "@/components/ui/spinner"
import { DiffText } from "./DiffText"
import {
  useUpstreamChangesReview,
  type ReviewItem,
} from "@/hooks/useUpstreamChangesReview"
import { emitTargetCellRepin } from "@/lib/sync/events-emit"
import { ROLE } from "@/lib/sync/role-policy"
import type { FileReference } from "@/lib/parsers/types"

const REPIN_MIN_ROLE = ROLE.REVIEWER // 300
const BULK_MIN_ROLE = ROLE.PROJECT_LEAD // 500

export interface UpstreamChangesPanelProps {
  projectId: string
  files: readonly Pick<FileReference, "id" | "name">[]
  getToken: (fileId: string) => Promise<string | null>
  /** The caller's resolved role level on this project. */
  roleLevel: number | null
  username: string
}

/** Per-item key — stable identity for selection state across revalidates. */
function itemKey(item: ReviewItem): string {
  return `${item.fileId} ${item.cellId}`
}

export function UpstreamChangesPanel({
  projectId,
  files,
  getToken,
  roleLevel,
  username,
}: UpstreamChangesPanelProps) {
  const navigate = useNavigate()
  const { groups, totalFlagged, isLoading, isError, revalidate } = useUpstreamChangesReview({
    projectId,
    files,
    getToken,
  })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [openBatches, setOpenBatches] = useState<Set<string>>(new Set())
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set())
  const [skippedKeys, setSkippedKeys] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const canRepin = (roleLevel ?? 0) >= REPIN_MIN_ROLE
  const canBulk = (roleLevel ?? 0) >= BULK_MIN_ROLE

  const allItems = useMemo(() => groups.flatMap((g) => g.items), [groups])
  const selectedItems = useMemo(
    () => allItems.filter((it) => selected.has(itemKey(it))),
    [allItems, selected],
  )

  function toggleBatch(batchId: string) {
    setOpenBatches((prev) => {
      const next = new Set(prev)
      if (next.has(batchId)) next.delete(batchId)
      else next.add(batchId)
      return next
    })
  }

  function toggleSelected(item: ReviewItem) {
    if (!item.target) return // nothing to repin without a target row
    setSelected((prev) => {
      const next = new Set(prev)
      const key = itemKey(item)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function openToRetranslate(item: ReviewItem) {
    navigate(`/project/${projectId}/editor/file/${item.fileId}?cellId=${encodeURIComponent(item.cellId)}`)
  }

  /**
   * Repins one item; returns whether it was actually applied.
   *
   * The projection's WHERE clause (`event_id = expectedTargetEventId`) is a
   * silent no-op if a translator re-committed the target after this item's
   * data was fetched — the fresher pin must win (spec §7/§4). Detecting that
   * from the client requires a post-hoc check (route.ts's /events response
   * has no per-statement rows-affected signal — see event-projection.ts's
   * `target.cell.repin` case comment): refetch the row and compare
   * `sourceEventId` to what we asked to set it to. Equal → applied.
   * Different → either it was already equal (true no-op-but-idempotent) or a
   * newer commit moved the head first (real race) — both cases are safe to
   * report as "skipped" since the intended pin did not land.
   */
  async function repinOne(item: ReviewItem): Promise<boolean> {
    if (!item.target || !item.newSourceEventId) return false
    const jwt = await getToken(item.fileId)
    if (!jwt) throw new Error("could not obtain a sync token")
    const newSourceEventId = item.newSourceEventId
    await emitTargetCellRepin({
      projectId,
      fileId: item.fileId,
      cellId: item.cellId,
      sourceEventId: newSourceEventId,
      expectedTargetEventId: item.target.eventId,
      author: username,
    })
    const { fetchCellsByIds } = await import("@/lib/sync/cells-read")
    const rows = await fetchCellsByIds(projectId, item.fileId, [item.cellId], jwt)
    const targetRow = rows.find((r) => r.side === "target")
    return targetRow?.sourceEventId === newSourceEventId
  }

  async function handleRepinSingle(item: ReviewItem) {
    if (!canRepin || !item.target) return
    const key = itemKey(item)
    setError(null)
    setBusyKeys((prev) => new Set(prev).add(key))
    try {
      const applied = await repinOne(item)
      if (!applied) {
        setSkippedKeys((prev) => new Set(prev).add(key))
      }
      revalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyKeys((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  async function handleBulkRepin() {
    if (!canBulk || selectedItems.length === 0) return
    setError(null)
    const keys = selectedItems.map(itemKey)
    setBusyKeys((prev) => new Set([...prev, ...keys]))
    const skipped: string[] = []
    try {
      for (const item of selectedItems) {
        const key = itemKey(item)
        try {
          const applied = await repinOne(item)
          if (!applied) skipped.push(key)
        } catch (err) {
          console.warn("[UpstreamChangesPanel] bulk repin failed for", key, err)
          skipped.push(key)
        }
      }
      setSkippedKeys(new Set(skipped))
      setSelected(new Set())
      revalidate()
    } finally {
      setBusyKeys((prev) => {
        const next = new Set(prev)
        for (const k of keys) next.delete(k)
        return next
      })
    }
  }

  if (isLoading && groups.length === 0) {
    return (
      <Card>
        <CardHeader><CardTitle>Upstream changes</CardTitle></CardHeader>
        <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="h-4 w-4" /> Checking for upstream changes…
        </CardContent>
      </Card>
    )
  }

  if (isError && groups.length === 0) {
    return (
      <Card>
        <CardHeader><CardTitle>Upstream changes</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Couldn&apos;t load upstream changes right now.{" "}
          <button type="button" className="underline" onClick={() => revalidate()}>Retry</button>
        </CardContent>
      </Card>
    )
  }

  if (totalFlagged === 0) {
    return (
      <Card id="section-upstream-changes">
        <CardHeader><CardTitle>Upstream changes</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Nothing flagged — this project is current with its upstream source.
        </CardContent>
      </Card>
    )
  }

  return (
    <Card id="section-upstream-changes">
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>Upstream changes</CardTitle>
        <Badge variant="secondary">{totalFlagged} flagged</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        {!canRepin && (
          <p className="text-xs text-muted-foreground">
            Reviewer or above required to accept a change; project lead required to accept in bulk.
          </p>
        )}
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}

        {canBulk && selectedItems.length > 0 && (
          <div className="flex items-center justify-between rounded border bg-muted/40 px-3 py-2">
            <span className="text-sm">{selectedItems.length} selected</span>
            <Button size="sm" onClick={() => void handleBulkRepin()}>
              <CheckCheck className="me-1.5 h-4 w-4" />
              Accept as-is ({selectedItems.length})
            </Button>
          </div>
        )}

        {groups.map((group, groupIdx) => {
          // Default-open the first (newest) batch until the user has
          // explicitly toggled any batch.
          const isOpen = openBatches.size === 0 ? groupIdx === 0 : openBatches.has(group.batchId)
          return (
            <Collapsible
              key={group.batchId}
              open={isOpen}
              onOpenChange={() => toggleBatch(group.batchId)}
            >
              <CollapsibleTrigger className="flex w-full items-center justify-between rounded border px-3 py-2 text-start text-sm font-medium hover:bg-muted/40">
                <span>
                  Sync batch — {new Date(group.serverTs).toLocaleString()}
                </span>
                <Badge variant="outline">{group.cellCount} cell{group.cellCount === 1 ? "" : "s"}</Badge>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2 space-y-2">
                {group.items.map((item) => {
                  const key = itemKey(item)
                  const busy = busyKeys.has(key)
                  const skipped = skippedKeys.has(key)
                  return (
                    <div
                      key={key}
                      className="flex items-start gap-3 rounded border px-3 py-2"
                      data-testid="review-item"
                    >
                      {canBulk && (
                        <label className="flex items-center pt-0.5">
                          <Checkbox
                            checked={selected.has(key)}
                            onCheckedChange={() => toggleSelected(item)}
                            disabled={!item.target || busy}
                            aria-label={`Select ${item.cellId} for bulk repin`}
                          />
                        </label>
                      )}
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">{item.fileName}</span>
                          <span>·</span>
                          <span className="font-mono">{item.cellId}</span>
                          {item.category === "tombstoned" && (
                            <Badge variant="destructive">
                              <Trash2 data-icon="inline-start" />
                              removed upstream
                            </Badge>
                          )}
                          {!item.target && (
                            <Badge variant="secondary">awaiting upstream translation</Badge>
                          )}
                          {skipped && (
                            <Badge variant="outline">
                              <AlertTriangle data-icon="inline-start" />
                              skipped — retranslated since
                            </Badge>
                          )}
                        </div>
                        {item.category === "tombstoned" ? (
                          <p className="text-sm text-muted-foreground">
                            This line was removed upstream.
                            {item.target && (
                              <> Its translation is kept: <span className="italic">&ldquo;{item.target.value}&rdquo;</span></>
                            )}
                          </p>
                        ) : (
                          <DiffText oldValue={item.oldValue} newValue={item.newValue} />
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Button variant="outline" size="sm" onClick={() => openToRetranslate(item)}>
                          <ArrowRight className="me-1 h-3.5 w-3.5" />
                          Open
                        </Button>
                        {item.target && (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={!canRepin || busy}
                            onClick={() => void handleRepinSingle(item)}
                          >
                            {busy ? <Spinner className="h-3.5 w-3.5" /> : <CheckCheck className="me-1 h-3.5 w-3.5" />}
                            Accept as-is
                          </Button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </CollapsibleContent>
            </Collapsible>
          )
        })}
      </CardContent>
    </Card>
  )
}
