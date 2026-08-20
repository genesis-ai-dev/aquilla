import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { Section } from "@/components/ui/page"
import { buttonVariants } from "@/components/ui/button"
import { ROLE } from "@/lib/frontier/roles"
import { formatAgentCredits } from "@/lib/billing/plans"
import { getOrgBilling, type OrgBilling } from "@/lib/sync/billing"
import { orgSettingsPath } from "@/lib/navigation/org-paths"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n/I18nProvider"

/**
 * Compact agent-credit usage on the org overview. Maintainer+ only —
 * same trust boundary as CreditsPanel. Self-hides on 403 / error.
 */
export function BillingUsagePanel({
  jwt,
  orgId,
  orgRoleLevel,
}: {
  jwt: string
  orgId: number
  orgRoleLevel: number
}) {
  const t = useT()
  const [data, setData] = useState<OrgBilling | null>(null)

  useEffect(() => {
    if (orgRoleLevel < ROLE.MAINTAINER) return
    let cancelled = false
    getOrgBilling(jwt, orgId)
      .then((d) => {
        if (!cancelled) setData(d)
      })
      .catch(() => {
        if (!cancelled) setData(null)
      })
    return () => {
      cancelled = true
    }
  }, [jwt, orgId, orgRoleLevel])

  if (orgRoleLevel < ROLE.MAINTAINER || !data) return null

  const allowance = data.allowanceCredits
  const used = data.creditsUsed
  const pct = allowance && allowance > 0 ? Math.min(100, Math.round((used / allowance) * 100)) : 0

  return (
    <Section
      title={t("billing.usage.aiWords")}
      description={
        data.plan === "field"
          ? "Field Plan allowance for this 4-week period"
          : data.plan === "enterprise"
            ? "Enterprise allowance across target-language lanes"
            : "Explore allowance for this 4-week period"
      }
      action={
        <Link to={orgSettingsPath(orgId, "billing")} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
          {t("billing.usage.open")}
        </Link>
      }
      data-testid="billing-usage-panel"
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm tabular-nums">
          <span className="font-semibold">{formatAgentCredits(used)}</span>
          {allowance != null ? (
            <span className="text-muted-foreground"> / {formatAgentCredits(allowance)}</span>
          ) : (
            <span className="text-muted-foreground"> {t("billing.usage.words")}</span>
          )}
        </p>
        {allowance != null ? <span className="text-xs text-muted-foreground">{pct}%</span> : null}
      </div>
      {allowance != null ? (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} aria-hidden />
        </div>
      ) : null}
    </Section>
  )
}
