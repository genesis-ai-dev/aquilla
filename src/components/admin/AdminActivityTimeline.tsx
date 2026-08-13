import { useState } from "react"
import { Activity as ActivityIcon } from "lucide-react"
import { EmptyState } from "@/components/ui/empty"
import { Badge } from "@/components/ui/badge"
import { formatRelativeTime } from "@/lib/time/relative"
import { UsernameWithAvatar } from "@/components/UsernameWithAvatar"
import type { AdminActivity } from "@/lib/frontier/admin"

/**
 * The global activity feed as a timeline rather than a 4-column table. A left
 * rail of dots reads chronologically at a glance; the type is a small chip and
 * the timestamp is relative ("3 hours ago"). Reused on the Overview home with a
 * `limit` + "View all" affordance.
 */
export function AdminActivityTimeline({
  activity,
  limit,
  now,
}: {
  activity: AdminActivity[]
  limit?: number
  now?: number
}) {
  // Stable fallback clock when a parent doesn't pin one (e.g. the Activity tab).
  const [fallbackNow] = useState(() => Date.now())
  const nowMs = now ?? fallbackNow
  if (activity.length === 0) {
    return (
      <EmptyState
        variant="inline"
        icon={ActivityIcon}
        title="No activity yet"
        description="Cross-tenant events appear here as people work."
      />
    )
  }

  const items = limit == null ? activity : activity.slice(0, limit)

  return (
    <ol className="relative space-y-4 pl-4">
      {/* The rail */}
      <span aria-hidden className="absolute left-[3px] top-1.5 bottom-1.5 w-px bg-border" />
      {items.map((a) => (
        <li key={a.id} className="relative">
          <span
            aria-hidden
            className="absolute -left-4 top-1.5 size-[7px] rounded-md bg-primary ring-2 ring-background"
          />
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-0.5">
              <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm text-foreground">
                <UsernameWithAvatar
                  username={a.username ?? `User ${a.userId}`}
                  label={a.username ?? `#${a.userId}`}
                  size="xs"
                  nameClassName="text-sm"
                />
                <span className="text-muted-foreground">{a.description ?? "did something"}</span>
              </div>
              {a.type && (
                <Badge variant="secondary">{a.type}</Badge>
              )}
            </div>
            <time className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
              {formatRelativeTime(a.timestamp, nowMs) ?? "—"}
            </time>
          </div>
        </li>
      ))}
    </ol>
  )
}
