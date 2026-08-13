import { useCallback, useEffect, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { CreditCard, ExternalLink } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { SettingsGroup, SettingsRow } from "@/components/ui/page"
import { Spinner } from "@/components/ui/spinner"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import {
  FIELD_PLAN,
  formatUsdFromCents,
  formatWordCount,
} from "@/lib/billing/plans"
import { ROLE } from "@/lib/frontier/roles"
import {
  getOrgBilling,
  startBillingCheckout,
  startBillingPortal,
  type OrgBilling,
} from "@/lib/sync/billing"
import { ORG_SETTINGS_SECTION_DESCRIPTIONS, ORG_SETTINGS_SECTION_TITLES } from "./constants"
import { OrgSettingsDetailPage } from "./OrgSettingsDetailPage"

function usagePct(used: number, allowance: number | null): number {
  if (allowance == null || allowance <= 0) return 0
  return Math.min(100, Math.round((used / allowance) * 100))
}

function planLabel(plan: OrgBilling["plan"]): string {
  if (plan === "field") return "Field Plan"
  if (plan === "enterprise") return "Enterprise"
  return "No paid plan"
}

export function OrgSettingsBilling() {
  const { activeOrg, activeOrgId } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const canManage = (activeOrg?.role?.level ?? 0) >= ROLE.MAINTAINER

  const [data, setData] = useState<OrgBilling | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<"field" | "addon" | "portal" | null>(null)

  const [searchParams, setSearchParams] = useSearchParams()
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    const checkout = searchParams.get("checkout")
    if (checkout !== "success" && checkout !== "cancel") return
    setNotice(checkout === "success" ? "Payment received. Usage updates in a moment." : "Checkout canceled.")
    const next = new URLSearchParams(searchParams)
    next.delete("checkout")
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  const load = useCallback(async () => {
    if (!jwt || activeOrgId == null) return
    setLoading(true)
    setError(null)
    try {
      setData(await getOrgBilling(jwt, activeOrgId))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load billing.")
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [jwt, activeOrgId])

  useEffect(() => {
    void load()
  }, [load])

  async function go(kind: "field" | "addon" | "portal") {
    if (!jwt || activeOrgId == null) return
    setBusy(kind)
    setError(null)
    try {
      const url =
        kind === "portal"
          ? await startBillingPortal(jwt, activeOrgId)
          : await startBillingCheckout(jwt, activeOrgId, kind)
      window.location.assign(url)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start Stripe.")
      setBusy(null)
    }
  }

  const allowance = data?.allowanceWords ?? null
  const pct = usagePct(data?.wordsUsed ?? 0, allowance)

  return (
    <OrgSettingsDetailPage
      title={ORG_SETTINGS_SECTION_TITLES.billing}
      description={ORG_SETTINGS_SECTION_DESCRIPTIONS.billing}
    >
      {notice ? (
        <p className="text-sm text-muted-foreground" role="status">
          {notice}
        </p>
      ) : null}

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Spinner className="size-3.5" />
          <span className="text-sm">Loading billing…</span>
        </div>
      ) : !canManage || data == null ? (
        <p className="text-sm text-muted-foreground">
          Billing is visible to organization maintainers.
        </p>
      ) : (
        <div className="flex flex-col gap-10">
          <SettingsGroup label="Plan">
            <SettingsRow
              label="Current plan"
              description={
                data.plan === "field"
                  ? `${formatUsdFromCents(FIELD_PLAN.priceCents)} every ${FIELD_PLAN.intervalDays} days, including ${formatWordCount(FIELD_PLAN.includedWords)} AI words.`
                  : data.plan === "enterprise"
                    ? "Billed offline. AI usage stops at the contracted hard cap."
                    : "Subscribe to meter AI words and buy more when a period runs hot."
              }
              control={
                <Badge variant={data.plan === "none" ? "outline" : "default"} data-testid="billing-plan">
                  {planLabel(data.plan)}
                </Badge>
              }
            />
            {data.plan === "none" ? (
              <SettingsRow
                label="Field Plan"
                description={`${formatUsdFromCents(FIELD_PLAN.priceCents)} / 4 weeks · ${formatWordCount(FIELD_PLAN.includedWords)} words included · ${formatUsdFromCents(FIELD_PLAN.addonPriceCents)} per extra ${formatWordCount(FIELD_PLAN.addonWords)} words.`}
                control={
                  <Button
                    onClick={() => void go("field")}
                    disabled={!data.canSubscribe || busy != null}
                    data-testid="subscribe-field-plan"
                  >
                    <CreditCard data-icon="inline-start" />
                    {busy === "field" ? "Redirecting…" : "Subscribe"}
                  </Button>
                }
              />
            ) : (
              <SettingsRow
                label="Manage"
                description="Update the card, invoices, or cancel in Stripe."
                control={
                  <Button
                    variant="outline"
                    onClick={() => void go("portal")}
                    disabled={!data.canManage || busy != null}
                    data-testid="manage-billing"
                  >
                    <ExternalLink data-icon="inline-start" />
                    {busy === "portal" ? "Redirecting…" : "Open customer portal"}
                  </Button>
                }
              />
            )}
          </SettingsGroup>

          <SettingsGroup label="AI words this period">
            <SettingsRow label="Usage" block>
              <div className="space-y-3" data-testid="billing-usage">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-2xl font-heading font-semibold tabular-nums">
                    {formatWordCount(data.wordsUsed)}
                    <span className="ml-1.5 text-sm font-normal text-muted-foreground">
                      {allowance == null ? "words recorded" : `/ ${formatWordCount(allowance)}`}
                    </span>
                  </p>
                  {allowance != null ? (
                    <span className="text-xs tabular-nums text-muted-foreground">{pct}%</span>
                  ) : null}
                </div>
                {allowance != null ? (
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{ width: `${pct}%` }}
                      aria-hidden
                    />
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Unpaid orgs are not capped. Subscribe to get a 100,000-word allowance every four weeks.
                  </p>
                )}
                {data.plan === "field" ? (
                  <p className="text-xs text-muted-foreground">
                    {data.addonPacks > 0
                      ? `${data.addonPacks} add-on pack${data.addonPacks === 1 ? "" : "s"} this period.`
                      : "No add-on packs this period."}
                  </p>
                ) : null}
              </div>
            </SettingsRow>
            {data.plan === "field" && !data.talkToUs ? (
              <SettingsRow
                label="Need more words?"
                description={`${formatUsdFromCents(FIELD_PLAN.addonPriceCents)} adds ${formatWordCount(FIELD_PLAN.addonWords)} words to this period only.`}
                control={
                  <Button
                    variant="outline"
                    onClick={() => void go("addon")}
                    disabled={!data.canBuyAddon || busy != null}
                    data-testid="buy-word-addon"
                  >
                    {busy === "addon" ? "Redirecting…" : "Add 100,000 words"}
                  </Button>
                }
              />
            ) : null}
            {data.talkToUs || data.plan === "enterprise" ? (
              <SettingsRow
                label="Talk to us"
                description={
                  data.plan === "enterprise"
                    ? "Enterprise usage is hard-capped. A human raises the ceiling."
                    : "Past 25 million words a year, Field Plan add-ons stop and we route the deal."
                }
                control={
                  <a
                    href="mailto:support@aquilla.app"
                    className={cn(buttonVariants({ variant: "outline" }))}
                  >
                    Email support
                  </a>
                }
              />
            ) : null}
          </SettingsGroup>
        </div>
      )}

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </OrgSettingsDetailPage>
  )
}
