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
  TIER_CREDITS,
  formatAgentCredits,
  formatUsdFromCents,
  normalizeBillingPlan,
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
import { useT } from "@/lib/i18n/I18nProvider"

function usagePct(used: number, allowance: number | null): number {
  if (allowance == null || allowance <= 0) return 0
  return Math.min(100, Math.round((used / allowance) * 100))
}

function planLabel(plan: OrgBilling["plan"]): string {
  const resolved = normalizeBillingPlan(plan)
  if (resolved === "field") return "Field Plan"
  if (resolved === "enterprise") return "Enterprise"
  return "Explore"
}

export function OrgSettingsBilling() {
  const t = useT()
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

  const allowance = data?.allowanceCredits ?? null
  const used = data?.creditsUsed ?? 0
  const pct = usagePct(used, allowance)
  const fieldCredits = data?.fieldPlan.fieldCreditsPerCycle ?? TIER_CREDITS.field.creditsPerCycle
  const addonCredits = data?.fieldPlan.addonCredits ?? TIER_CREDITS.field.creditsPerCycle
  const checkoutEnabled = data?.checkoutEnabled === true

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
          <span className="text-sm">{t("billing.loading")}</span>
        </div>
      ) : !canManage || data == null ? (
        <p className="text-sm text-muted-foreground">
          {t("billing.maintainersOnly")}
        </p>
      ) : (
        <div className="flex flex-col gap-10">
          <SettingsGroup label={t("billing.plan.group")}>
            <SettingsRow
              label={t("billing.plan.current")}
              description={
                data.plan === "field"
                  ? `${formatUsdFromCents(data.fieldPlan.priceCents)} every ${data.fieldPlan.intervalDays} days, including ${formatAgentCredits(fieldCredits)} agent credits.`
                  : data.plan === "enterprise"
                    ? "Billed offline. Agent credits scale with each target-language lane."
                    : `${formatAgentCredits(data.fieldPlan.exploreCreditsPerCycle ?? TIER_CREDITS.explore.creditsPerCycle)} agent credits each 4-week cycle on Explore.`
              }
              control={
                <Badge variant={normalizeBillingPlan(data.plan) === "explore" ? "outline" : "default"} data-testid="billing-plan">
                  {planLabel(data.plan)}
                </Badge>
              }
            />
            {normalizeBillingPlan(data.plan) === "explore" ? (
              <SettingsRow
                label={t("billing.plan.field")}
                description={`${formatUsdFromCents(data.fieldPlan.priceCents)} / 4 weeks · ${formatAgentCredits(fieldCredits)} agent credits included · ${formatUsdFromCents(data.fieldPlan.addonPriceCents)} per extra ${formatAgentCredits(addonCredits)} credits.`}
                control={
                  <Button
                    onClick={() => void go("field")}
                    disabled={!checkoutEnabled || !data.canSubscribe || busy != null}
                    data-testid="subscribe-field-plan"
                  >
                    <CreditCard data-icon="inline-start" />
                    {busy === "field" ? "Redirecting…" : "Coming soon"}
                  </Button>
                }
              />
            ) : (
              <SettingsRow
                label={t("billing.plan.manage")}
                description={t("billing.plan.manageHelp")}
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

          <SettingsGroup label={t("billing.usage.period")}>
            <SettingsRow label={t("billing.usage.label")} block>
              <div className="space-y-3" data-testid="billing-usage">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-2xl font-heading font-semibold tabular-nums">
                    {formatAgentCredits(used)}
                    <span className="ml-1.5 text-sm font-normal text-muted-foreground">
                      {allowance == null ? "credits recorded" : `/ ${formatAgentCredits(allowance)}`}
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
                ) : null}
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
                label={t("billing.addon.prompt")}
                description={`${formatUsdFromCents(data.fieldPlan.addonPriceCents)} adds ${formatAgentCredits(addonCredits)} agent credits to this period only.`}
                control={
                  <Button
                    variant="outline"
                    onClick={() => void go("addon")}
                    disabled={!checkoutEnabled || !data.canBuyAddon || busy != null}
                    data-testid="buy-word-addon"
                  >
                    {busy === "addon" ? "Redirecting…" : `Add ${formatAgentCredits(addonCredits)} credits`}
                  </Button>
                }
              />
            ) : null}
            {data.talkToUs || data.plan === "enterprise" ? (
              <SettingsRow
                label={t("billing.contact.prompt")}
                description={
                  data.plan === "enterprise"
                    ? "Enterprise credits are set per target-language lane. A human raises the ceiling."
                    : "At this volume, Field Plan add-ons stop and we route the deal."
                }
                control={
                  <a
                    href="mailto:support@aquilla.app"
                    className={cn(buttonVariants({ variant: "outline" }))}
                  >
                    {t("billing.contact.email")}
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
