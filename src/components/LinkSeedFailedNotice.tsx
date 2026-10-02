// AQU-1544 — "the link was saved, but the source files have not arrived".
//
// A live link is saved first and filled by a first mirror sync. When that sync
// fails the project is linked and empty of the upstream's files, and until this
// slice nothing said so: the Import dialog closed as on success, the settings
// card flipped to the linked state, and the create dialog opened an empty
// project. The only trace was a 502 in the browser console.
//
// One sentence and one action, shared by every entry point so they read the
// same: `LinkSeedFailedNotice` is the inline form the link flow shows in place
// of closing (Import dialog, settings card); `LinkSeedFailedBanner` is the
// full-width form for the page the user lands on (workspace, project overview),
// shown only while `link-seed-status` holds a mark for the project.
//
// The message is a fixed sentence, never the server's: the status code is not
// something a translator can act on, and "saved, not arrived, try again" is.

import { AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useLinkSeedFailed, useLinkSeedRetry } from "@/hooks/useLinkSeedRetry"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"

export interface LinkSeedFailedNoticeProps {
  projectId: string
  /** Called once a retry brings the files in, so the host can refresh. */
  onSynced: () => void
  /** `inline` sits inside a dialog or card; `banner` spans the page. */
  variant?: "inline" | "banner"
}

export function LinkSeedFailedNotice({
  projectId,
  onSynced,
  variant = "inline",
}: LinkSeedFailedNoticeProps) {
  const t = useT()
  const { retrying, retryFailed, retry } = useLinkSeedRetry(projectId, onSynced)
  return (
    <div
      role="alert"
      data-testid="link-seed-failed-notice"
      className={cn(
        "flex gap-3 text-sm text-amber-900 dark:text-amber-100",
        variant === "banner"
          ? "w-full items-center border-b border-amber-300 bg-amber-50 px-4 py-2 dark:border-amber-700/60 dark:bg-amber-950/40"
          : "items-start rounded border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-700 dark:bg-amber-950",
      )}
    >
      <AlertTriangle
        className={cn("h-4 w-4 shrink-0", variant === "inline" && "mt-0.5")}
        aria-hidden
      />
      <div className="flex-1 space-y-1">
        <p>{t("projectSettings.linkSource.seedFailedMessage")}</p>
        {retryFailed && !retrying && (
          <p>{t("projectSettings.linkSource.seedRetryFailedNote")}</p>
        )}
      </div>
      <Button
        size="sm"
        variant="outline"
        className="shrink-0"
        disabled={retrying}
        onClick={() => void retry()}
      >
        {retrying
          ? t("projectSettings.linkSource.seedRetryingButton")
          : t("projectSettings.linkSource.previewRetryButton")}
      </Button>
    </div>
  )
}

export interface LinkSeedFailedBannerProps {
  projectId: string
  onSynced: () => void
}

/** Renders nothing unless this session knows the project's first sync failed. */
export function LinkSeedFailedBanner({ projectId, onSynced }: LinkSeedFailedBannerProps) {
  const failed = useLinkSeedFailed(projectId)
  if (!failed) return null
  return <LinkSeedFailedNotice projectId={projectId} onSynced={onSynced} variant="banner" />
}
