import { useEffect, useState, type ReactNode } from "react"
import { getOrgUsage, type OrgUsage } from "@/lib/sync/usage"
import { Section } from "@/components/ui/page"
import { UsernameWithAvatar } from "@/components/UsernameWithAvatar"

/**
 * Per-member usage rollup for the org Overview (manager oversight). Fetches
 * the maintainer-gated usage endpoint; a non-manager caller gets a 403, which
 * getOrgUsage translates to null — so the section simply doesn't render.
 * Also renders nothing when all member usage is zero (org hasn't used TTS/AI
 * yet), so it never adds noise to a fresh workspace.
 *
 * Mirrors WorkloadRollup exactly: same effect pattern, same self-hiding logic.
 */
export function UsageRollup({ jwt, orgId, action }: { jwt: string; orgId: number; action?: ReactNode }) {
  const [data, setData] = useState<OrgUsage | null>(null)

  useEffect(() => {
    let cancelled = false
    getOrgUsage(jwt, orgId)
      .then((d) => { if (!cancelled) setData(d) })
      .catch(() => { if (!cancelled) setData(null) }) // transient error → hide
    return () => { cancelled = true }
  }, [jwt, orgId])

  // null = 403 (non-manager) or fetch error → hide
  if (!data) return null

  const hasUsage = data.members.some(
    (m) => m.audioSeconds > 0 || m.ttsRequests > 0 || m.llmRequests > 0,
  )
  if (!hasUsage) return null

  return (
    <Section title="Team usage" action={action} contentClassName="pt-0">
      <div className="divide-y">
        {data.members.map((m) => {
          const mins = Math.floor(m.audioSeconds / 60)
          const secs = Math.round(m.audioSeconds % 60)
          const audioLabel =
            m.audioSeconds < 60
              ? `${Math.round(m.audioSeconds)} s audio`
              : secs > 0
                ? `${mins} min ${secs} s audio`
                : `${mins} min audio`
          const requests = m.ttsRequests + m.llmRequests
          return (
            <div key={m.userId} className="flex items-center gap-4 py-2.5 first:pt-0">
              <div className="min-w-0 flex-1">
                <UsernameWithAvatar username={m.username ?? `User ${m.userId}`} />
              </div>
              <div className="shrink-0 text-right">
                <p className="text-sm font-semibold tabular-nums">{audioLabel}</p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {requests} AI request{requests !== 1 ? "s" : ""}
                </p>
              </div>
            </div>
          )
        })}
      </div>
    </Section>
  )
}
