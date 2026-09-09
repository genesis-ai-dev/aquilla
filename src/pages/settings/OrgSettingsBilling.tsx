import { useCallback, useEffect, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { CreditCard, ExternalLink } from "lucide-react"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { SettingsGroup, SettingsRow } from "@/components/ui/page"
import { Spinner } from "@/components/ui/spinner"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import {
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
  const [billingInterval, setBillingInterval] = useState<"monthly" | "annual">("annual")
  const [busy, setBusy] = useState<"field" | "portal" | null>(null)

  const [searchParams, setSearchParams] = useSearchParams()
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    const checkout = searchParams.get("checkout")
    if (checkout !== "success" && checkout !== "cancel") return
    setNotice(checkout === "success" ? "Checkout completed. Your plan updates after payment is confirmed." : "Checkout canceled.")
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

  async function go(kind: "field" | "portal") {
    if (!jwt || activeOrgId == null) return
    setBusy(kind)
    setError(null)
    try {
      const url =
        kind === "portal"
          ? await startBillingPortal(jwt, activeOrgId)
          : await startBillingCheckout(jwt, activeOrgId, kind, 1, billingInterval)
      window.location.assign(url)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start Stripe.")
      setBusy(null)
    }
  }

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
                data.plan === "enterprise"
                  ? "Custom annual quote for support and platform usage."
                  : "Your organization’s plan covers its projects and collaborators."
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
                description="For ongoing team translation and review, with up to 20 collaborators."
                control={
                  <div className="flex flex-wrap items-center gap-3">
                  <Select
                    value={billingInterval}
                    onValueChange={(value) => { if (value) setBillingInterval(value) }}
                  >
                    <SelectTrigger aria-label="Field billing period">
                      <SelectValue>{billingInterval === "annual" ? "Annual" : "Monthly"}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="annual">Annual</SelectItem>
                        <SelectItem value="monthly">Monthly</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <Button
                    onClick={() => void go("field")}
                    disabled={!checkoutEnabled || !data.canSubscribe || busy != null}
                    data-testid="subscribe-field-plan"
                  >
                    <CreditCard data-icon="inline-start" />
                    {busy === "field" ? "Redirecting…" : checkoutEnabled ? "Upgrade to Field" : "Coming soon"}
                  </Button>
                  </div>
                }
              />
            ) : data.canManage ? (
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
            ) : null}
          </SettingsGroup>

          <SettingsGroup label="Plans and covered access">
            <SettingsRow
              label="ETEN affiliate or Bible-translation team?"
              description="Your Field access may already be covered. Contact us to confirm coverage and arrange access without paying for a subscription."
              control={
                <a
                  href="mailto:hello@aquilla.app?subject=ETEN%20affiliate%20or%20Bible-translation%20access"
                  className={cn(buttonVariants({ variant: "outline" }))}
                >
                  Check covered access
                </a>
              }
            />
            <SettingsRow
              label="Compare plans"
              description="See Field pricing or discuss a custom annual Enterprise quote."
              control={<a href="https://aquilla.app/pricing" className={cn(buttonVariants({ variant: "outline" }))}>View plans</a>}
            />
          </SettingsGroup>
          <SettingsGroup label="AI usage">
            <div data-testid="billing-usage" className="flex flex-col gap-3 text-sm text-muted-foreground">
              <p>Collaborators share your organization’s AI allowance across its projects.</p>
              <p>Weekly limits use a rolling seven-day window. Capacity returns as older usage leaves the window. Daily limits may also apply.</p>
              <p>Usage limits may pause affected AI requests until capacity is available again. Your projects remain available for manual editing and review.</p>
              <p>Self-service allowance purchases are not available. Contact us if your organization needs more capacity.</p>
              <a href="mailto:support@aquilla.app?subject=Organization%20AI%20capacity" className="underline">Discuss AI capacity</a>
            </div>
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
