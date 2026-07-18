// AQU-498: member productivity detail — recent actions + a rollup of which
// files a member has worked on, how much (cells/words), and when.
//
// Rendered ONLY inside ProjectOverview's Team card, which is already hard-gated
// by the AQU-485 memberProgressViewMinRole floor (SectionVisibilityGate) — this
// component itself does no permission check; it trusts its mount point. Data
// comes straight from the sync-worker event log (source of truth, AD-2) via
// GET /api/v1/projects/:projectId/members/:author/activity — see
// sync-worker/src/events/member-activity-read-route.ts for why the files
// rollup (cells/words/timing) is derived from the `cells` projection's
// `last_editor` column, which makes it reconcile with project totals by
// construction (a strict SQL subset of the same rows that feed file-level
// counts elsewhere on the dashboard).

import { X } from "lucide-react"
import { useMemberActivity } from "@/hooks/useMemberActivity"
import type { MemberActivityEvent } from "@/lib/sync/member-activity-read-types"
import { Button } from "@/components/ui/button"

const KIND_LABELS: Record<string, string> = {
  "target.cell.create": "Created a translation",
  "target.cell.commit": "Edited a translation",
  "target.cell.delete": "Deleted a translation",
  "source.cell.create": "Created a source cell",
  "source.cell.commit": "Edited a source cell",
  "cell.validate": "Validated a cell",
  "cell.unvalidate": "Un-validated a cell",
  "cell.waive": "Waived a QA flag",
  "cell.unwaive": "Un-waived a QA flag",
  "comment.create": "Left a comment",
  "comment.edit": "Edited a comment",
  "comment.resolve": "Resolved a comment",
  "cell.backtranslation.set": "Set a back-translation",
  "cell.audio.attach": "Attached audio",
  "cell.audio.select": "Selected an audio take",
  "cell.retime": "Retimed a cell",
}

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind
}

function formatTimestamp(ms: number | null): string {
  if (ms == null) return "—"
  return new Date(ms).toLocaleString()
}

export interface MemberActivityPanelProps {
  projectId: string
  /** The member's Aquilla username (events.author), not a numeric user id. */
  username: string
  getToken: () => Promise<string | null>
  onClose: () => void
}

/**
 * Recent actions + per-file rollup for one member. Caller is responsible for
 * permission gating (see file header) and for supplying a project-scoped
 * sync-token minter via `getToken`.
 */
export function MemberActivityPanel({ projectId, username, getToken, onClose }: MemberActivityPanelProps) {
  const { events, fileRollup, isLoading, isError } = useMemberActivity({
    projectId,
    author: username,
    getToken,
  })

  return (
    <div
      className="mt-3 rounded-lg border bg-background/60 p-4"
      data-testid="member-activity-panel"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Activity — {username}</h3>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-muted-foreground"
          onClick={onClose}
          aria-label="Close member activity"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {isLoading && events.length === 0 && fileRollup.length === 0 ? (
        <p className="text-sm text-muted-foreground">Loading activity…</p>
      ) : isError ? (
        <p className="text-sm text-destructive">Couldn't load activity for {username}.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Files worked on
            </h4>
            {fileRollup.length === 0 ? (
              <p className="text-xs text-muted-foreground">No tracked edits yet.</p>
            ) : (
              <ul className="space-y-1.5" data-testid="member-file-rollup">
                {fileRollup.map((f) => (
                  <li key={f.fileId} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate font-medium">{f.fileName}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {f.cellsTouched} cells · {f.wordCount} words · {formatTimestamp(f.lastActivityAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Recent actions
            </h4>
            {events.length === 0 ? (
              <p className="text-xs text-muted-foreground">No recent actions.</p>
            ) : (
              <ul className="space-y-1.5" data-testid="member-recent-actions">
                {events.map((e: MemberActivityEvent) => (
                  <li key={e.id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate">{kindLabel(e.kind)}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {formatTimestamp(e.serverTs)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
