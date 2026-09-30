import { useEffect, useState } from "react"
import { Section, StatTile, STAT_TILE_GRID } from "@/components/ui/page"
import { getAdminMigrationStatus, type MigrationStatus } from "@/lib/frontier/admin"

const REFRESH_MS = 15_000

function queueCount(status: MigrationStatus, kind: "content" | "audio"): number {
  return status.queue.jobs
    .filter((job) => job.kind === kind && job.stage !== "done")
    .reduce((sum, job) => sum + job.count, 0)
}

function timestamp(value: number | string | null | undefined): string {
  if (value == null) return "Never"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString()
}

export function AdminMigrationSection({ jwt }: { jwt: string }) {
  const [status, setStatus] = useState<MigrationStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try {
        const next = await getAdminMigrationStatus(jwt)
        if (!cancelled) {
          setStatus(next)
          setError(null)
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!cancelled) {
          setLoading(false)
          timer = setTimeout(() => void refresh(), REFRESH_MS)
        }
      }
    }
    void refresh()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [jwt])

  if (loading && !status) return <p className="text-sm text-muted-foreground">Loading migration status…</p>
  if (error && !status) return <p className="text-sm text-destructive">{error}</p>
  if (!status) {
    return (
      <Section title="Codex migration" description="The daemon has not published a status snapshot yet.">
        {error && <p className="text-sm text-destructive">{error}</p>}
      </Section>
    )
  }

  const stale = Date.now() - new Date(status.heartbeatAt).getTime() > 60_000
  const pending = (kind: "content" | "audio") => queueCount(status, kind)

  return (
    <div className="space-y-6">
      <Section
        title="Codex migration"
        description={`${status.runner}${status.dryRun ? " · dry run" : " · live"} · ${stale ? "heartbeat is stale" : "daemon is running"}`}
      >
        {error && <p className="mb-3 text-sm text-destructive">Status refresh failed: {error}</p>}
        <div className={STAT_TILE_GRID}>
          <StatTile label="Content queued" value={pending("content")} hint="waiting or retrying" />
          <StatTile label="Audio queued" value={pending("audio")} hint="waiting or retrying" />
          <StatTile label="Active jobs" value={status.active.length} hint="content and audio" />
          <StatTile label="Daemon heartbeat" value={stale ? "Stale" : "Live"} hint={timestamp(status.heartbeatAt)} />
        </div>
        <p className="mt-4 text-xs text-muted-foreground">
          Last webhook poll: {timestamp(status.lastInboxPollAt)} ({status.lastInboxEnqueued} jobs queued)
          <span className="mx-2">·</span>
          Last reconcile: {timestamp(status.lastReconcileAt)} ({status.lastReconcileEnqueued} jobs queued)
        </p>
        <p className="mt-1 text-xs text-muted-foreground">Status snapshot updated {timestamp(status.updatedAt)} · panel refreshes every 15 seconds.</p>
      </Section>

      {status.active.length > 0 && (
        <Section title="In progress" description="Current jobs on the migration daemon.">
          <div className="divide-y divide-border">
            {status.active.map((job) => (
              <div key={job.jobId} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                <span className="font-medium">{job.kind} · {job.stage} · job {job.jobId}</span>
                <span className="text-muted-foreground">
                  {job.progress
                    ? `${job.progress.copied}/${job.progress.total} audio copies · ${job.progress.failed} failed`
                    : `Started ${timestamp(job.startedAt)}`}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section title="Recent jobs" description="Failures keep their retry time and error here.">
        {status.queue.recentJobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No migration jobs recorded.</p>
        ) : (
          <div className="divide-y divide-border">
            {status.queue.recentJobs.map((job) => (
              <div key={job.id} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="font-medium">{job.namespace}/{job.project_name} · {job.kind}</span>
                  <span className="text-muted-foreground">{job.stage} · {timestamp(job.updated_at)}</span>
                </div>
                {job.error && <p className="mt-1 text-xs text-destructive">{job.error}</p>}
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}
