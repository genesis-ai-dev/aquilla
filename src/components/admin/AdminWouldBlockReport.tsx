import { useEffect, useState } from "react"
import { Section } from "@/components/ui/page"
import { getAdminWouldBlock, type BillingMeterMode, type WouldBlockOrg, type WouldBlockPeriod } from "@/lib/frontier/admin"

/**
 * AQU-2067 (unified billing T10): who the meter would have refused in shadow
 * mode, this weekly period and last. This is the evidence reviewed before the
 * shadow → enforce flip (spec §5.4).
 */
export function AdminWouldBlockReport({ jwt }: { jwt: string }) {
  const [data, setData] = useState<{ meterMode: BillingMeterMode; orgs: WouldBlockOrg[] } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    getAdminWouldBlock(jwt).then(
      (next) => { if (alive) setData(next) },
      (err: unknown) => { if (alive) setError(err instanceof Error ? err.message : String(err)) },
    )
    return () => { alive = false }
  }, [jwt])

  return (
    <Section
      title="Would-block report"
      description="Orgs and users the meter would have refused, in each org’s current and previous weekly period. Review every org here before enforcing."
    >
      <div data-testid="would-block-report">
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {data ? (
          <>
            <p className="mb-3 text-xs text-muted-foreground" data-testid="meter-mode">
              Meter mode: <span className="font-semibold text-foreground">{data.meterMode}</span>
              {data.meterMode === "off" ? " — no usage is recorded, so this report stays empty." : null}
            </p>
            {data.orgs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No org would have been blocked in the last two periods.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-left text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-3 font-medium">Org</th>
                      <th className="py-1 pr-3 font-medium">Plan</th>
                      <th className="py-1 pr-3 font-medium">Used</th>
                      <th className="py-1 pr-3 font-medium">This period</th>
                      <th className="py-1 font-medium">Previous period</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.orgs.map((org) => (
                      <tr key={org.orgId} className="border-t align-top" data-testid={`would-block-${org.orgId}`}>
                        <td className="py-2 pr-3">
                          {org.orgName ?? `#${org.orgId}`}
                          <div className="text-[10px] text-muted-foreground">#{org.orgId}</div>
                        </td>
                        <td className="py-2 pr-3 capitalize">{org.tier ?? "—"}</td>
                        <td className="py-2 pr-3 tabular-nums">
                          {org.pctUsed == null ? "unmetered" : `${Math.round(org.pctUsed * 100)}%`}
                        </td>
                        <td className="py-2 pr-3"><PeriodCell period={org.current} /></td>
                        <td className="py-2"><PeriodCell period={org.previous} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : null}
      </div>
    </Section>
  )
}

function PeriodCell({ period }: { period: WouldBlockPeriod }) {
  if (period.requests === 0) return <span className="text-muted-foreground">—</span>
  const rails = Object.entries(period.byRail).map(([rail, n]) => `${rail} ${n}`).join(" · ")
  return (
    <div className="flex flex-col gap-0.5">
      <span className="tabular-nums">
        <span className="font-semibold">{period.requests}</span> blocked · ${period.rawUsd.toFixed(2)} raw
      </span>
      <span className="text-[10px] text-muted-foreground">{rails}</span>
      <ul className="text-[10px] text-muted-foreground">
        {period.users.map((u) => (
          <li key={u.userId ?? "system"}>
            {u.userId == null ? "background work" : (u.username ?? `user #${u.userId}`)} ×{u.requests} ({u.rails.join(", ")})
          </li>
        ))}
      </ul>
    </div>
  )
}
