import { useEffect, useRef, useState, type ReactNode } from "react"
import { getOrgUsage, type OrgUsage } from "@/lib/sync/usage"
import { Section } from "@/components/ui/page"
import { useT } from "@/lib/i18n/I18nProvider"
import { UserChip } from "@/components/UserChip"

/**
 * Per-member usage rollup for the org Overview (manager oversight). Fetches
 * the usage endpoint, which the org's member-progress and member-list settings
 * gate (AQU-1771). A refusal (403, which getOrgUsage translates to null) is
 * reported through `onRefused` so the parent drops the card altogether; a
 * transient failure, and an org whose members have used nothing yet, render
 * nothing, so it never adds noise to a fresh workspace.
 *
 * Mirrors WorkloadRollup exactly: same effect pattern, same self-hiding logic.
 */
export function UsageRollup({
  jwt,
  orgId,
  action,
  onRefused,
}: {
  jwt: string
  orgId: number
  action?: ReactNode
  /** The server refused the read (403): the caller is below the org's settings. */
  onRefused?: () => void
}) {
  const t = useT()
  const [data, setData] = useState<OrgUsage | null>(null)
  // Read through a ref so a parent's inline callback does not refetch.
  const onRefusedRef = useRef(onRefused)
  useEffect(() => { onRefusedRef.current = onRefused }, [onRefused])

  useEffect(() => {
    let cancelled = false
    getOrgUsage(jwt, orgId)
      .then((d) => {
        if (cancelled) return
        setData(d)
        if (d === null) onRefusedRef.current?.()
      })
      .catch(() => { if (!cancelled) setData(null) }) // transient error → hide
    return () => { cancelled = true }
  }, [jwt, orgId])

  // null = refused or fetch error → hide
  if (!data) return null

  const hasUsage = data.members.some(
    (m) => m.audioSeconds > 0 || m.ttsRequests > 0 || m.llmRequests > 0,
  )
  if (!hasUsage) return null

  return (
    <Section title={t("org.usageRollup.title")} action={action} contentClassName="pt-0">
      <div className="divide-y">
        {data.members.map((m) => {
          const mins = Math.floor(m.audioSeconds / 60)
          const secs = Math.round(m.audioSeconds % 60)
          const audioLabel =
            m.audioSeconds < 60
              ? t("org.usageRollup.audioSecondsOnly", { seconds: Math.round(m.audioSeconds) })
              : secs > 0
                ? t("org.usageRollup.audioMinutesSeconds", { minutes: mins, seconds: secs })
                : t("org.usageRollup.audioMinutesOnly", { minutes: mins })
          const requests = m.ttsRequests + m.llmRequests
          return (
            <div key={m.userId} className="flex items-center gap-4 py-2.5 first:pt-0">
              <div className="min-w-0 flex-1">
                <UserChip userId={m.userId} username={m.username} />
              </div>
              <div className="shrink-0 text-end">
                <p className="text-sm font-semibold tabular-nums">{audioLabel}</p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {t("org.usageRollup.aiRequestCount", { count: requests })}
                </p>
              </div>
            </div>
          )
        })}
      </div>
    </Section>
  )
}
