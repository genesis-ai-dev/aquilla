// Personal usage section for the Preferences page.
//
// Shows today's audio minutes generated + AI (LLM) request count, plus a
// compact 7-day history bar chart (audio minutes per day). No pricing is shown.
// Renders a skeleton while loading, and a gentle "no data yet" state when the
// endpoint returns zeros. Swallows fetch errors silently (the section just hides
// its content so it never blocks the Preferences page).

import { useEffect, useState } from "react"
import { AppTooltip } from "@/components/ui/tooltip"
import { Section } from "@/components/ui/page"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { getMyUsage, type MyUsage } from "@/lib/sync/usage"

/** Inline hook — only used by UsageSection. */
function useUserUsage(jwt: string | null): {
  data: MyUsage | null
  loading: boolean
} {
  const [data, setData] = useState<MyUsage | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!jwt) { setData(null); return }
    let cancelled = false
    setLoading(true)
    getMyUsage(jwt)
      .then((d) => { if (!cancelled) setData(d) })
      .catch(() => { if (!cancelled) setData(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [jwt])

  return { data, loading }
}

/** Convert raw audio seconds to a display string like "1 min 23 s" or "45 s". */
function fmtAudioSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`
  const mins = Math.floor(seconds / 60)
  const secs = Math.round(seconds % 60)
  return secs > 0 ? `${mins} min ${secs} s` : `${mins} min`
}

/**
 * 7-day audio history as a simple bar chart. Each bar is proportional to the
 * max value across the week; zero days render a hairline so the row is never
 * totally invisible.
 */
function MiniBarChart({ history }: { history: MyUsage["history"] }) {
  const maxSeconds = Math.max(...history.map((d) => d.audioSeconds), 1)
  return (
    <div className="mt-3">
      <p className="mb-1.5 text-xs text-muted-foreground">7-day audio history</p>
      <div className="flex items-end gap-1 h-10" aria-label="7-day audio history bar chart">
        {history.map((day) => {
          const pct = Math.max((day.audioSeconds / maxSeconds) * 100, day.audioSeconds > 0 ? 8 : 2)
          const label = `${day.date}: ${fmtAudioSeconds(day.audioSeconds)}`
          return (
            <AppTooltip key={day.date} content={label}>
              <div
                aria-label={label}
                className="flex-1 rounded-sm bg-primary/40 min-h-[2px] transition-all"
                style={{ height: `${pct}%` }}
              />
            </AppTooltip>
          )
        })}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        {history.length > 0 && (
          <>
            <span>{history[0]?.date?.slice(5)}</span>
            <span>{history[history.length - 1]?.date?.slice(5)}</span>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Preferences section: personal usage stats for the signed-in user.
 * Inserted after the Privacy section and before PersonalProviderSection.
 * No pricing. Hides gracefully when signed out or when the endpoint fails.
 */
export function UsageSection() {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const { data, loading } = useUserUsage(jwt)

  if (!jwt) return null

  const today = data?.today
  const hasHistory = (data?.history?.length ?? 0) > 0
  const hasAnyData =
    (today?.audioSeconds ?? 0) > 0 ||
    (today?.ttsRequests ?? 0) > 0 ||
    (today?.llmRequests ?? 0) > 0 ||
    hasHistory

  return (
    <Section
      title="Usage"
      description="Your audio and AI activity. No pricing is shown here."
    >
      {loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : !hasAnyData ? (
        <p className="text-xs text-muted-foreground">No usage recorded yet.</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <div>
              <p className="text-xs text-muted-foreground">Audio generated today</p>
              <p className="text-sm font-medium tabular-nums">
                {fmtAudioSeconds(today?.audioSeconds ?? 0)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">AI requests today</p>
              <p className="text-sm font-medium tabular-nums">
                {(today?.ttsRequests ?? 0) + (today?.llmRequests ?? 0)}
              </p>
            </div>
          </div>
          {hasHistory && <MiniBarChart history={data!.history} />}
        </>
      )}
    </Section>
  )
}
