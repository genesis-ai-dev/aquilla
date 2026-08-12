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
import { useI18n } from "@/lib/i18n/I18nProvider"
import { formatDateTime } from "@/lib/i18n/format"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { TFunction } from "@/lib/i18n/I18nProvider"
import type { MemberActivityEvent } from "@/lib/sync/member-activity-read-types"
import { Button } from "@/components/ui/button"

const KIND_LABEL_KEYS: Record<string, MessageKey> = {
  "target.cell.create": "org.memberActivityPanel.kindTargetCellCreate",
  "target.cell.commit": "org.memberActivityPanel.kindTargetCellCommit",
  "target.cell.delete": "org.memberActivityPanel.kindTargetCellDelete",
  "source.cell.create": "org.memberActivityPanel.kindSourceCellCreate",
  "source.cell.commit": "org.memberActivityPanel.kindSourceCellCommit",
  "cell.validate": "org.memberActivityPanel.kindCellValidate",
  "cell.unvalidate": "org.memberActivityPanel.kindCellUnvalidate",
  "cell.waive": "org.memberActivityPanel.kindCellWaive",
  "cell.unwaive": "org.memberActivityPanel.kindCellUnwaive",
  "comment.create": "org.memberActivityPanel.kindCommentCreate",
  "comment.edit": "org.memberActivityPanel.kindCommentEdit",
  "comment.resolve": "org.memberActivityPanel.kindCommentResolve",
  "cell.backtranslation.set": "org.memberActivityPanel.kindCellBacktranslationSet",
  "cell.audio.attach": "org.memberActivityPanel.kindCellAudioAttach",
  "cell.audio.select": "org.memberActivityPanel.kindCellAudioSelect",
  "cell.retime": "org.memberActivityPanel.kindCellRetime",
}

// Falls back to the raw event kind for a kind this client doesn't recognize
// yet — never real UI vocabulary, so it stays untranslated (shouldn't happen).
function kindLabel(t: TFunction, kind: string): string {
  const key = KIND_LABEL_KEYS[kind]
  return key ? t(key) : kind
}

function formatTimestamp(ms: number | null, locale: string): string {
  if (ms == null) return "—"
  return formatDateTime(ms, locale)
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
  const { locale, t } = useI18n()
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
        <h3 className="text-sm font-medium">{t("org.memberActivityPanel.heading", { username })}</h3>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          onClick={onClose}
          aria-label={t("org.memberActivityPanel.closeAriaLabel")}
        >
          <X />
        </Button>
      </div>

      {isLoading && events.length === 0 && fileRollup.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("org.memberActivityPanel.loadingActivity")}</p>
      ) : isError ? (
        <p className="text-sm text-destructive">{t("org.memberActivityPanel.loadErrorFor", { username })}</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <h4 className="mb-2 text-xs font-semibold text-muted-foreground">
              {t("org.memberActivityPanel.filesWorkedOnHeading")}
            </h4>
            {fileRollup.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("org.memberActivityPanel.noTrackedEdits")}</p>
            ) : (
              <ul className="space-y-1.5" data-testid="member-file-rollup">
                {fileRollup.map((f) => (
                  <li key={f.fileId} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate font-medium">{f.fileName}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {f.cellsTouched} cells · {f.wordCount} words · {formatTimestamp(f.lastActivityAt, locale)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h4 className="mb-2 text-xs font-semibold text-muted-foreground">
              {t("org.memberActivityPanel.recentActionsHeading")}
            </h4>
            {events.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("org.memberActivityPanel.noRecentActions")}</p>
            ) : (
              <ul className="space-y-1.5" data-testid="member-recent-actions">
                {events.map((e: MemberActivityEvent) => (
                  <li key={e.id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate">{kindLabel(t, e.kind)}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {formatTimestamp(e.serverTs, locale)}
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
