import { useMemo } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import type { OutboxRecord } from "@/lib/sync/outbox"
import type { CqrsEventKind } from "@/lib/sync/cqrs-types"

interface Props {
  /** Trigger element that opens the popover. Receives no props — wrap as needed. */
  trigger: React.ReactNode
  records: OutboxRecord[]
}

type Status = "pending" | "retrying" | "quarantined-auth" | "quarantined-other"

interface Row {
  rec: OutboxRecord
  status: Status
}

function classify(rec: OutboxRecord): Status {
  if (rec.attempts === 0) return "pending"
  if (!rec.lastError) return "pending"
  const s = rec.lastError.status
  if (s === 401 || s === 403) return "quarantined-auth"
  if (s === 0 || s >= 500) return "retrying"
  return "quarantined-other"
}

function statusPillClass(status: Status): string {
  switch (status) {
    case "pending":
      return "bg-muted text-muted-foreground"
    case "retrying":
      return "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
    case "quarantined-auth":
      return "bg-rose-100 text-rose-800 dark:bg-rose-950/40 dark:text-rose-300"
    case "quarantined-other":
      return "bg-rose-100 text-rose-800 dark:bg-rose-950/40 dark:text-rose-300"
  }
}

function statusLabel(status: Status): string {
  switch (status) {
    case "pending":
      return "Pending"
    case "retrying":
      return "Retrying"
    case "quarantined-auth":
      return "Sign in to retry"
    case "quarantined-other":
      return "Stuck"
  }
}

function eventLabel(kind: CqrsEventKind): string {
  switch (kind) {
    case "cell.commit":
      return "Edit"
    case "cell.validate":
      return "Validate"
    case "cell.unvalidate":
      return "Unvalidate"
    default:
      return kind
  }
}

function shortId(id: string | undefined): string {
  if (!id) return "—"
  if (id.length <= 8) return id
  return `${id.slice(0, 6)}…`
}

function formatRelativeTime(ts: number, now: number): string {
  const delta = Math.max(0, now - ts)
  if (delta < 5_000) return "just now"
  const sec = Math.round(delta / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.round(hr / 24)
  return `${d}d ago`
}

export function OutboxInspectorPopover({ trigger, records }: Props) {
  const now = Date.now()

  const rows = useMemo<Row[]>(() => {
    return records.map((rec) => ({ rec, status: classify(rec) }))
  }, [records])

  const summary = useMemo(() => {
    const counts = { commit: 0, validate: 0, unvalidate: 0 }
    for (const { rec } of rows) {
      if (rec.event.kind === "cell.commit") counts.commit += 1
      else if (rec.event.kind === "cell.validate") counts.validate += 1
      else if (rec.event.kind === "cell.unvalidate") counts.unvalidate += 1
    }
    return counts
  }, [rows])

  const hasAuthBlock = rows.some((r) => r.status === "quarantined-auth")

  return (
    <Popover>
      <PopoverTrigger render={trigger as React.ReactElement} />
      <PopoverContent
        className="w-[380px] max-w-[calc(100vw-2rem)] p-0"
        side="top"
        align="end"
        sideOffset={6}
      >
        <div className="flex flex-col">
          <div className="border-b border-border px-3 py-2">
            <div className="flex items-baseline justify-between">
              <h3 className="text-sm font-medium">Outbox</h3>
              <span className="text-xs tabular-nums text-muted-foreground">
                {rows.length === 0 ? "all synced" : `${rows.length} pending`}
              </span>
            </div>
            {rows.length > 0 && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {[
                  summary.commit ? `${summary.commit} edit${summary.commit === 1 ? "" : "s"}` : null,
                  summary.validate ? `${summary.validate} validate` : null,
                  summary.unvalidate ? `${summary.unvalidate} unvalidate` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
            {hasAuthBlock && (
              <p
                className="mt-1.5 rounded-sm bg-rose-50 px-2 py-1 text-xs text-rose-800 dark:bg-rose-950/40 dark:text-rose-300"
                role="alert"
              >
                Some changes can&rsquo;t reach the server because your session
                expired. They&rsquo;re still saved locally — sign in again to
                retry.
              </p>
            )}
          </div>

          {rows.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              Every local change is synced.
            </div>
          ) : (
            <ScrollArea className="max-h-[420px]">
              <ul className="divide-y divide-border">
                {rows.map(({ rec, status }) => (
                  <li key={rec.id} className="px-3 py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-medium">
                        {eventLabel(rec.event.kind as CqrsEventKind)}
                      </span>
                      <span
                        className={cn(
                          "rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                          statusPillClass(status),
                        )}
                      >
                        {statusLabel(status)}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="tabular-nums">
                        {formatRelativeTime(rec.enqueuedAt, now)}
                      </span>
                      <span aria-hidden>·</span>
                      <span>cell {shortId(rec.event.cellId ?? undefined)}</span>
                      {rec.attempts > 0 && (
                        <>
                          <span aria-hidden>·</span>
                          <span className="tabular-nums">
                            {rec.attempts}
                            {rec.attempts === 1 ? " try" : " tries"}
                          </span>
                        </>
                      )}
                    </div>
                    {rec.lastError && (
                      <div className="mt-0.5 truncate text-xs text-rose-700 dark:text-rose-400">
                        {rec.lastError.status > 0
                          ? `${rec.lastError.status} · ${rec.lastError.reason}`
                          : rec.lastError.reason}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </ScrollArea>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
