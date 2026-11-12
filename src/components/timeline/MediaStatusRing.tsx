// The status ring on the media view's top bar. (Media redesign, layout —
// canvas board 23: "the status ring beside History opens the full status on a
// click".)
//
// The media view has no footer any more, so the file's status lives here: a
// ring for how far the file has come, a dot for the connection, and on a click
// the whole status — the line counts the footer used to show, Live and Synced,
// and when this project last saved. Esc or a click elsewhere closes it.

import { useEffect, useRef, useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { AppTooltip } from "@/components/ui/tooltip"
import { describeSyncStatus, type SyncStatus } from "@/components/SyncStatusIndicator"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { formatRelativeTime } from "@/lib/i18n/format"
import { useLastUploadAt } from "@/lib/offline/sync-times"
import { PROGRESS_COLOR } from "@/lib/progress/progress-palette"
import { cn } from "@/lib/utils"

export interface MediaStatusRingProps {
  /** How far the file has come, 0–1 — the footer's own figure. */
  fraction: number
  /** The footer reports recordings (audio) rather than text. */
  audio: boolean
  syncStatus: SyncStatus
  fileName: string
  projectId?: string | null
  /** The full status: the footer's counts, and Live / Synced. */
  children: ReactNode
  /** Edits waiting to reach the server. The moment it empties is "saved". */
  pending: number
  /** Opening the Panels menu closes this. */
  closeWhen?: boolean
}

const SIZE = 18
const STROKE = 2.5

export function MediaStatusRing({ fraction, audio, syncStatus, fileName, projectId, pending, children, closeWhen }: MediaStatusRingProps) {
  const { t, locale } = useI18n()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (closeWhen) setOpen(false)
  }, [closeWhen])
  // When this project last saved: the moment the outbox last emptied in this
  // session, else the offline upload time this device keeps. Neither yet, and
  // the line is left out rather than claiming "never".
  const offlineUpload = useLastUploadAt(projectId ?? undefined)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const pendingBefore = useRef(pending)
  useEffect(() => {
    if (pendingBefore.current > 0 && pending === 0) setSavedAt(Date.now())
    pendingBefore.current = pending
  }, [pending])
  const lastSaved = savedAt ?? offlineUpload
  const { dot } = describeSyncStatus(syncStatus)
  const r = (SIZE - STROKE) / 2
  const c = 2 * Math.PI * r
  const color = audio ? PROGRESS_COLOR.audioRecorded : PROGRESS_COLOR.textTranslated
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <AppTooltip content={t("editor.dock.statusTip")} disabled={open}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              className="relative size-[30px]"
              aria-label={t("editor.dock.statusTip")}
              data-testid="status-ring"
            >
              <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="size-[18px] shrink-0 -rotate-90" aria-hidden>
                <circle cx={SIZE / 2} cy={SIZE / 2} r={r} fill="none" stroke="currentColor" strokeWidth={STROKE} className="text-muted-foreground/20" />
                <circle
                  cx={SIZE / 2}
                  cy={SIZE / 2}
                  r={r}
                  fill="none"
                  stroke={color}
                  strokeWidth={STROKE}
                  strokeDasharray={c}
                  strokeDashoffset={c - Math.max(0, Math.min(1, fraction)) * c}
                  strokeLinecap="round"
                />
              </svg>
              <span aria-hidden className={cn("absolute end-0.5 top-0.5 size-1.5 rounded-full", dot)} />
            </Button>
          }
        />
      </AppTooltip>
      <PopoverContent align="end" className="w-[320px] gap-2 p-3" data-testid="status-popover">
        <div className="truncate text-sm font-semibold">{t("editor.dock.statusTitle", { file: fileName })}</div>
        <div className="flex flex-col gap-2 text-sm text-muted-foreground [&_footer]:flex-wrap [&_footer]:p-0">{children}</div>
        {lastSaved !== null && (
          <div className="text-xs text-muted-foreground" data-testid="status-last-saved">
            {t("editor.dock.lastSaved", { when: formatRelativeTime(lastSaved, locale) })}
          </div>
        )}
        <div className="text-[11px] text-muted-foreground">{t("editor.dock.statusCloseNote")}</div>
      </PopoverContent>
    </Popover>
  )
}
