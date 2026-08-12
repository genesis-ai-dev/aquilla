import { useMemo, useState } from "react"
import { Check, ChevronRight, AlertTriangle, LogIn, RotateCw, Clock, Ban, Trash2 } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Badge } from "@/components/ui/badge"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { removeOutboxEvents, requeueOutboxEvents, type OutboxRecord } from "@/lib/sync/outbox"
import type { CqrsEventKind } from "@/lib/sync/outbox-types"
import { useT } from "@/lib/i18n/I18nProvider"
import type { TFunction } from "@/lib/i18n/I18nProvider"
import { RichMessage } from "@/lib/i18n/RichMessage"

/** The bold, tabular-figure numeral inside one outbox summary item. It is a node
 *  rather than inline JSX around the noun so the translated string decides where
 *  the numeral sits relative to its noun. */
function SummaryCount({ value }: { value: number }) {
  return <span className="font-medium tabular-nums text-foreground">{value}</span>
}

interface Props {
  trigger: React.ReactNode
  records: OutboxRecord[]
  /** True total of queued records (may exceed `records.length`, which the
   *  source caps for the overlay). Drives the "+N more" overflow note so a
   *  large bulk import doesn't appear to have fewer pending than it does.
   *  Falls back to `records.length` when omitted. */
  pendingCount?: number
  /** Reset backoff + force an immediate flush. When provided, the inspector
   *  shows a "Retry now" control and revives quarantined records on retry. */
  onRetryNow?: () => void
}

/** Cap the number of record rows rendered at once. The records list is already
 *  bounded upstream, but a large bulk import can still queue hundreds — render
 *  a slice and summarise the rest so the popover stays light. */
const DISPLAY_CAP = 100

/**
 * needs-signin  → 401: the session JWT is dead; signing in again fixes it.
 * no-permission → 403: not allowed (role too low, or the change belongs to a
 *                 different project than the open one). Re-auth will NOT fix
 *                 it — the only resolutions are gaining access or discarding.
 * stuck         → exhausted the retry budget on transient errors.
 * retrying      → transient (network / 5xx), still within retry budget.
 */
type Status = "pending" | "retrying" | "needs-signin" | "no-permission" | "stuck"

/** Quarantined states the user can clear by discarding (no automatic recovery
 *  path). needs-signin is excluded: it self-heals on re-auth. */
function isDiscardable(status: Status): boolean {
  return status === "no-permission" || status === "stuck"
}

interface Row {
  rec: OutboxRecord
  status: Status
  preview: string
  fullText: string | null
}

function classify(rec: OutboxRecord): Status {
  // A token-mint failure stamps `lastError` without bumping `attempts` (so a
  // recoverable 401 never hits the failed cap), so classify on lastError alone
  // — not on attempts > 0, which would mislabel a stamped 401/403 as "Pending".
  if (!rec.lastError) return "pending"
  const s = rec.lastError.status
  // 403 is checked before the generic `failed` rollup so a permission failure
  // reads as "not allowed", never as the misleading "session expired".
  if (s === 403) return "no-permission"
  if (s === 401) return "needs-signin"
  if (rec.status === "failed") return "stuck"
  if (s === 0 || s >= 500) return "retrying"
  return "stuck"
}

// Higher value = more attention-grabbing. Sorted to top.
const STATUS_PRIORITY: Record<Status, number> = {
  "no-permission": 4,
  "needs-signin": 3,
  stuck: 2,
  retrying: 1,
  pending: 0,
}

function statusBadgeVariant(
  status: Status,
): "secondary" | "outline" | "destructive" {
  switch (status) {
    case "pending":
      return "outline"
    case "retrying":
      return "secondary"
    case "needs-signin":
    case "no-permission":
    case "stuck":
      return "destructive"
  }
}

function statusLabel(status: Status, t: TFunction): string {
  switch (status) {
    case "pending":
      return t("nav.outbox.statusPending")
    case "retrying":
      return t("nav.outbox.statusRetrying")
    case "needs-signin":
      return t("nav.outbox.statusNeedsSignin")
    case "no-permission":
      return t("nav.outbox.statusNoPermission")
    case "stuck":
      return t("nav.outbox.statusStuck")
  }
}

function StatusIcon({ status }: { status: Status }) {
  const cls = "size-3"
  switch (status) {
    case "pending":
      return <Clock className={cls} aria-hidden />
    case "retrying":
      return <RotateCw className={cls} aria-hidden />
    case "needs-signin":
      return <LogIn className={cls} aria-hidden />
    case "no-permission":
      return <Ban className={cls} aria-hidden />
    case "stuck":
      return <AlertTriangle className={cls} aria-hidden />
  }
}

function eventLabel(kind: CqrsEventKind, t: TFunction): string {
  switch (kind) {
    case "target.cell.commit":
      return t("nav.outbox.eventEdit")
    case "target.cell.create":
      return t("nav.outbox.eventNewCell")
    case "target.cell.delete":
      return t("nav.outbox.eventDeleteCell")
    case "target.cell.reorder":
      return t("nav.outbox.eventReorderCell")
    case "source.cell.commit":
      return t("nav.outbox.eventSourceEdit")
    case "source.cell.create":
      return t("nav.outbox.eventNewSourceCell")
    case "cell.validate":
      return t("nav.outbox.eventValidate")
    case "cell.unvalidate":
      return t("nav.outbox.eventUnvalidate")
    case "comment.create":
      return t("nav.outbox.eventNewComment")
    case "comment.edit":
      return t("nav.outbox.eventEditComment")
    case "comment.delete":
      return t("nav.outbox.eventDeleteComment")
    case "comment.resolve":
      return t("nav.outbox.eventResolveComment")
    case "file.create":
      return t("nav.outbox.eventNewFile")
    case "cell.audio.attach":
      return t("nav.outbox.eventAttachAudio")
    case "cell.audio.select":
      return t("nav.outbox.eventSelectAudio")
    case "cell.audio.remove":
      return t("nav.outbox.eventRemoveAudio")
    default:
      return kind
  }
}

function shortId(id: string | undefined | null): string {
  if (!id) return "—"
  if (id.length <= 8) return id
  return `${id.slice(0, 6)}…`
}

// Strip tags + collapse whitespace; safe for HTML payloads we'd otherwise
// render as code. Used for preview only — never re-rendered as HTML.
function plainText(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return `${s.slice(0, n - 1).trimEnd()}…`
}

/** Best-effort, human-readable preview of what the event will do. */
function getPreview(rec: OutboxRecord, t: TFunction): { preview: string; fullText: string | null } {
  const p = rec.event.payload as Record<string, unknown>
  const text = typeof p?.value === "string"
    ? p.value as string
    : typeof p?.body === "string"
      ? p.body as string
      : typeof p?.name === "string"
        ? p.name as string
        : ""
  if (text) {
    const clean = plainText(text)
    return { preview: truncate(clean, 140), fullText: clean.length > 140 ? clean : null }
  }
  // Fallbacks for events without text bodies
  switch (rec.event.kind) {
    case "cell.validate":
    case "cell.unvalidate":
      return {
        preview: t("nav.outbox.previewEditRef", { id: shortId((p?.editEventId as string) ?? undefined) }),
        fullText: null,
      }
    case "cell.audio.attach":
    case "cell.audio.select":
    case "cell.audio.remove": {
      const slot = typeof p?.slot === "string" ? (p.slot as string) : null
      return { preview: slot ? t("nav.outbox.previewAudioSlot", { slot }) : t("nav.outbox.previewAudio"), fullText: null }
    }
    default:
      return { preview: "", fullText: null }
  }
}

function formatRelativeTime(ts: number, now: number, t: TFunction): string {
  const delta = Math.max(0, now - ts)
  if (delta < 5_000) return t("nav.outbox.timeJustNow")
  const sec = Math.round(delta / 1000)
  if (sec < 60) return t("nav.outbox.timeSecondsAgo", { sec })
  const min = Math.round(sec / 60)
  if (min < 60) return t("nav.outbox.timeMinutesAgo", { min })
  const hr = Math.round(min / 60)
  if (hr < 24) return t("nav.outbox.timeHoursAgo", { hr })
  const d = Math.round(hr / 24)
  return t("nav.outbox.timeDaysAgo", { d })
}

export function OutboxInspectorPopover({ trigger, records, pendingCount, onRetryNow }: Props) {
  const t = useT()
  // Capture "now" once per mount. The popover is short-lived, so we don't
  // tick it forward — "5s ago" briefly drifting to "10s ago" while the user
  // reads is fine and avoids a per-second re-render.
  const [now] = useState(() => Date.now())
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const rows = useMemo<Row[]>(() => {
    const built = records.map<Row>((rec) => {
      const status = classify(rec)
      const { preview, fullText } = getPreview(rec, t)
      return { rec, status, preview, fullText }
    })
    // Stable sort: severity desc, then most recently enqueued first.
    built.sort((a, b) => {
      const dp = STATUS_PRIORITY[b.status] - STATUS_PRIORITY[a.status]
      if (dp !== 0) return dp
      return b.rec.enqueuedAt - a.rec.enqueuedAt
    })
    return built
  }, [records, t])

  const summary = useMemo(() => {
    const counts = { edits: 0, validation: 0, comments: 0, other: 0 }
    for (const { rec } of rows) {
      const k = rec.event.kind
      if (k === "target.cell.commit" || k === "target.cell.create" || k === "source.cell.commit" || k === "source.cell.create") counts.edits += 1
      else if (k === "cell.validate" || k === "cell.unvalidate") counts.validation += 1
      else if (k.startsWith("comment.")) counts.comments += 1
      else counts.other += 1
    }
    return counts
  }, [rows])

  const hasNeedsSignin = rows.some((r) => r.status === "needs-signin")
  const hasNoPermission = rows.some((r) => r.status === "no-permission")
  const hasStuck = rows.some((r) => r.status === "stuck")
  const discardableIds = useMemo(
    () => rows.filter((r) => isDiscardable(r.status)).map((r) => r.rec.id),
    [rows],
  )

  const discard = (ids: string[]) => {
    if (ids.length === 0) return
    // removeOutboxEvents notifies outbox subscribers, so usePendingOutboxRecords
    // re-reads and this popover re-renders without the discarded rows.
    void removeOutboxEvents(ids)
  }

  // Revive quarantined/stuck records to `pending`, then nudge the flusher to
  // run immediately (reset backoff). For records still pending (e.g. a 401
  // that self-heals after re-auth), requeue is a no-op and the flush is the
  // operative part.
  const retry = (ids: string[]) => {
    if (ids.length > 0) void requeueOutboxEvents(ids)
    onRetryNow?.()
  }
  const retryAll = () => retry(rows.map((r) => r.rec.id))

  // Render at most DISPLAY_CAP rows; summarise the remainder. `pendingCount` is
  // the true queue size (records is capped by the overlay source), so the
  // overflow reflects everything still queued, not just what's shown here.
  const shownRows = rows.slice(0, DISPLAY_CAP)
  const overflow = Math.max(0, (pendingCount ?? rows.length) - shownRows.length)

  return (
    <Popover>
      <PopoverTrigger render={trigger as React.ReactElement} />
      <PopoverContent
        className="flex max-h-[min(560px,calc(100vh-6rem))] w-[420px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden p-0"
        side="top"
        align="end"
        sideOffset={6}
        aria-label={t("nav.outbox.popoverAriaLabel")}
      >
        <header className="shrink-0 border-b border-border bg-popover px-3 py-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold tracking-tight">{t("nav.outbox.title")}</h3>
            <span
              className="text-xs tabular-nums text-muted-foreground"
              aria-live="polite"
              aria-atomic="true"
            >
              {(() => {
                // SUB-9: failed (quarantined) rows are in the feed now — count
                // them separately so a refused change is never labeled "pending"
                // and "All synced" only appears when the outbox is truly empty.
                const failed = rows.filter((r) => r.rec.status === "failed").length
                const pending = rows.length - failed
                if (rows.length === 0) return t("nav.outbox.allSynced")
                if (failed === 0) return t("nav.outbox.pendingCount", { count: pending })
                if (pending === 0) return t("nav.outbox.failedCount", { count: failed })
                return t("nav.outbox.pendingAndFailedCount", { pending, failed })
              })()}
            </span>
          </div>
          {rows.length > 0 && (
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              {/* Each item is one translated sentence whose `{count}` is
                  substituted with the styled numeral node below. Splitting it
                  into `<span>{n}</span> {noun}` — the shape this used to have —
                  hardcoded numeral-before-noun, which Burmese and other
                  classifier languages cannot follow. The number still appears
                  exactly once: <RichMessage> hands the scalar to `t()` for
                  plural selection and substitutes the node for the placeholder,
                  so nothing prints "3 3 edits". */}
              {summary.edits > 0 && (
                <span>
                  <RichMessage
                    k="nav.outbox.summaryEdits"
                    count={summary.edits}
                    values={{ count: <SummaryCount value={summary.edits} /> }}
                  />
                </span>
              )}
              {summary.validation > 0 && (
                <span>
                  <RichMessage
                    k="nav.outbox.summaryValidations"
                    count={summary.validation}
                    values={{ count: <SummaryCount value={summary.validation} /> }}
                  />
                </span>
              )}
              {summary.comments > 0 && (
                <span>
                  <RichMessage
                    k="nav.outbox.summaryComments"
                    count={summary.comments}
                    values={{ count: <SummaryCount value={summary.comments} /> }}
                  />
                </span>
              )}
              {summary.other > 0 && (
                <span>
                  <RichMessage
                    k="nav.outbox.summaryOther"
                    count={summary.other}
                    values={{ count: <SummaryCount value={summary.other} /> }}
                  />
                </span>
              )}
            </p>
          )}
          {rows.length > 0 && onRetryNow && (
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                onClick={retryAll}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <RotateCw className="size-3" aria-hidden />
                {t("nav.outbox.retryNow")}
              </button>
            </div>
          )}
          {hasNeedsSignin && (
            <p
              role="alert"
              className="mt-2 flex items-start gap-1.5 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
            >
              <LogIn className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>{t("nav.outbox.sessionExpiredAlert")}</span>
            </p>
          )}
          {(hasNoPermission || hasStuck) && (
            <div
              role="alert"
              className="mt-2 flex items-start gap-1.5 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
            >
              <Ban className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <div className="min-w-0 flex-1">
                <span>
                  {hasNoPermission ? t("nav.outbox.noPermissionMessage") : t("nav.outbox.stuckMessage")}
                </span>
                {discardableIds.length > 0 && (
                  <button
                    type="button"
                    onClick={() => discard(discardableIds)}
                    className="mt-1.5 flex items-center gap-1 rounded font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Trash2 className="size-3" aria-hidden />
                    {t("nav.outbox.discardStuckChangesButton", {
                      count: discardableIds.length,
                    })}
                  </button>
                )}
              </div>
            </div>
          )}
        </header>

        {rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-3 py-10 text-center">
            <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Check className="size-4" aria-hidden />
            </span>
            <p className="text-sm font-medium">{t("nav.outbox.allCaughtUpTitle")}</p>
            <p className="text-xs text-muted-foreground">
              {t("nav.outbox.allCaughtUpDescription")}
            </p>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <ul className="divide-y divide-border" role="list">
              {shownRows.map(({ rec, status, preview, fullText }) => {
                const isOpen = !!expanded[rec.id]
                const hasMore = !!(fullText || rec.lastError || rec.event.cellId)
                return (
                  <li key={rec.id}>
                    <Collapsible
                      open={isOpen}
                      onOpenChange={(open) =>
                        setExpanded((s) => ({ ...s, [rec.id]: open }))
                      }
                    >
                      <CollapsibleTrigger
                        disabled={!hasMore}
                        className={cn(
                          "group/row flex w-full items-start gap-2 px-3 py-2.5 text-start transition-colors",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                          hasMore && "hover:bg-muted/60",
                          !hasMore && "cursor-default",
                        )}
                      >
                        <ChevronRight
                          aria-hidden
                          className={cn(
                            "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform",
                            isOpen && "rotate-90",
                            !hasMore && "opacity-0",
                          )}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-sm font-medium">
                              {eventLabel(rec.event.kind as CqrsEventKind, t)}
                            </span>
                            <Badge
                              variant={statusBadgeVariant(status)}
                              className="shrink-0 gap-1"
                            >
                              <StatusIcon status={status} />
                              <span>{statusLabel(status, t)}</span>
                            </Badge>
                          </div>
                          {preview && (
                            <p
                              className={cn(
                                "mt-1 text-xs leading-snug text-foreground/80",
                                !isOpen && "line-clamp-2",
                              )}
                            >
                              {isOpen && fullText ? fullText : preview}
                            </p>
                          )}
                          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                            <span className="tabular-nums">
                              {formatRelativeTime(rec.enqueuedAt, now, t)}
                            </span>
                            {rec.event.cellId && (
                              <>
                                <span aria-hidden>·</span>
                                <span className="font-mono">
                                  {t("common.cellLabel", { id: shortId(rec.event.cellId) })}
                                </span>
                              </>
                            )}
                            {rec.attempts > 0 && (
                              <>
                                <span aria-hidden>·</span>
                                <span className="tabular-nums">
                                  {t("nav.outbox.attempts", { count: rec.attempts })}
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                      </CollapsibleTrigger>
                      {hasMore && (
                        <CollapsibleContent className="overflow-hidden">
                          <div className="space-y-1.5 border-t border-border/60 bg-muted/30 px-3 py-2 ps-8 text-xs">
                            {rec.event.cellId && (
                              <div className="flex gap-2">
                                <span className="w-16 shrink-0 text-muted-foreground">{t("nav.outbox.cellDetailLabel")}</span>
                                <span className="font-mono text-foreground/90">
                                  {rec.event.cellId}
                                </span>
                              </div>
                            )}
                            <div className="flex gap-2">
                              <span className="w-16 shrink-0 text-muted-foreground">{t("nav.outbox.eventDetailLabel")}</span>
                              <span className="font-mono text-foreground/90">
                                {rec.event.id}
                              </span>
                            </div>
                            {rec.lastError && (
                              <div className="flex gap-2">
                                <span className="w-16 shrink-0 text-muted-foreground">{t("nav.outbox.errorDetailLabel")}</span>
                                <span className="text-destructive">
                                  {rec.lastError.status > 0
                                    ? `${rec.lastError.status} · ${rec.lastError.reason}`
                                    : rec.lastError.reason}
                                </span>
                              </div>
                            )}
                            {isDiscardable(status) && (
                              <div className="flex justify-end gap-1 pt-0.5">
                                {onRetryNow && (
                                  <button
                                    type="button"
                                    onClick={() => retry([rec.id])}
                                    className="flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                  >
                                    <RotateCw className="size-3" aria-hidden />
                                    {t("common.retry")}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => discard([rec.id])}
                                  className="flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                  <Trash2 className="size-3" aria-hidden />
                                  {t("nav.outbox.discardChangeButton")}
                                </button>
                              </div>
                            )}
                          </div>
                        </CollapsibleContent>
                      )}
                    </Collapsible>
                  </li>
                )
              })}
            </ul>
            {overflow > 0 && (
              <p className="px-3 py-2 text-center text-xs text-muted-foreground" role="status">
                {t("nav.outbox.overflowMore", { count: overflow })}
              </p>
            )}
          </div>
        )}

        <footer className="shrink-0 border-t border-border bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground">
          {rows.length > 0
            ? t("nav.outbox.footerPending")
            : t("nav.outbox.footerSynced")}
        </footer>
      </PopoverContent>
    </Popover>
  )
}
