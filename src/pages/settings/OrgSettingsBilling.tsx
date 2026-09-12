import { useEffect, useRef, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { ExternalLink } from "lucide-react"
import { BillingWorkspaceDetails } from "@/components/org/BillingWorkspaceSummary"
import { getBillingWorkspace, type BillingWorkspace } from "@/lib/sync/billing-workspace"
import { billingOfferLabels } from "../../../db/shared/billing-offers"
import { BillingOffers } from "@/components/org/BillingOffers"
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
  return "Free"
}

export function OrgSettingsBilling() {
  const t = useT()
  const { activeOrg, activeOrgId } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const canManage = (activeOrg?.role?.level ?? 0) >= ROLE.MAINTAINER

  const [result, setResult] = useState<{
    jwt: string; orgId: number; workspace: BillingWorkspace; legacy: OrgBilling | null
  } | null>(null)
  const [reload, setReload] = useState(0)
  const request = useRef(0)
  const current = result?.jwt === jwt && result.orgId === activeOrgId ? result : null
  const data = current?.legacy ?? null
  const workspace = current?.workspace ?? null
  const paid = workspace?.entitlement ?? null
  const [pending, setPending] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<"portal" | null>(null)

  const [searchParams, setSearchParams] = useSearchParams()
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    const checkout = searchParams.get("checkout")
    if (!["success", "cancel", "rehearsal"].includes(checkout ?? "")) return
    setNotice(checkout === "rehearsal" ? "Test checkout returned. Refresh billing to check payment confirmation." : checkout === "success" ? "Checkout completed. Your plan updates after payment is confirmed." : "Checkout canceled.")
    const next = new URLSearchParams(searchParams)
    next.delete("checkout")
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  useEffect(() => {
    const generation = ++request.current
    setResult(null)
    setError(null)
    setBusy(null)
    setPending(true)
    if (!jwt || activeOrgId == null || !canManage) return
    void (async () => {
      const workspace = await getBillingWorkspace(jwt, activeOrgId)
      const legacy = workspace.entitlement ? null : await getOrgBilling(jwt, activeOrgId)
      if (!workspace.entitlement && !legacy) throw new Error("Billing details are unavailable.")
      if (request.current === generation) setResult({ jwt, orgId: activeOrgId, workspace, legacy })
    })().catch(() => {
      if (request.current === generation) setError("Billing details are unavailable. Try again; your access stays unchanged.")
    }).finally(() => {
      if (request.current === generation) setPending(false)
    })
    return () => { request.current++ }
  }, [jwt, activeOrgId, canManage, reload])

  async function go(kind: "portal") {
    if (!jwt || activeOrgId == null) return
    const generation = request.current
    setBusy(kind)
    setError(null)
    try {
      const url = await startBillingPortal(jwt, activeOrgId)
      if (request.current === generation) window.location.assign(url)
    } catch (err) {
      if (request.current !== generation) return
      setError(err instanceof Error ? err.message : "Couldn't start Stripe.")
      setBusy(null)
    }
  }


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

      {!canManage ? (
        <p className="text-sm text-muted-foreground">{t("billing.maintainersOnly")}</p>
      ) : pending || (!current && !error) ? (
        <div className="flex items-center gap-2 text-muted-foreground" role="status">
          <Spinner className="size-3.5" />
          <span className="text-sm">{t("billing.loading")}</span>
        </div>
      ) : !workspace ? (
        <Button variant="outline" onClick={() => setReload(value => value + 1)}>Retry billing</Button>
      ) : (
        <div className="flex flex-col gap-10">
          <SettingsGroup label={t("billing.plan.group")}>
            <SettingsRow
              label={t("billing.plan.current")}
              description={
                paid ? (paid.billingInterval === "year" ? "Billed annually." : "Billed monthly.")
                  : data?.plan === "enterprise"
                  ? "Custom annual quote for support and platform usage."
                  : "Your organization’s plan covers its projects and collaborators."
              }
              control={
                <Badge variant={!paid && normalizeBillingPlan(data?.plan ?? "none") === "explore" ? "outline" : "default"} data-testid="billing-plan">
                  {paid ? billingOfferLabels[paid.offer] : planLabel(data!.plan)}
                </Badge>
              }
            />
            {!paid && data?.canManage ? (
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

          <Button variant="outline" onClick={() => setReload(value => value + 1)}>Refresh billing</Button>
          <BillingWorkspaceDetails data={workspace} />
          {jwt && activeOrgId != null ? <BillingOffers key={activeOrgId} jwt={jwt} orgId={activeOrgId} /> : null}
          <SettingsGroup label="Plans and covered access">
            <SettingsRow
              label="ETEN affiliate or Bible-translation team?"
              description="Your organization’s access may already be covered. Contact us to confirm coverage and arrange access without paying for a subscription."
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
              description="See Individual and Team pricing or discuss a custom annual Enterprise quote."
              control={<a href="https://aquilla.app/pricing" className={cn(buttonVariants({ variant: "outline" }))}>View plans</a>}
            />
          </SettingsGroup>
          <SettingsGroup label="AI usage">
            <div data-testid="billing-usage" className="flex flex-col gap-3 text-sm text-muted-foreground">
              <p>Collaborators share your organization’s AI allowance across its projects.</p>
              {paid ? <>
                <p>AI capacity resets every seven days from your plan’s activation, with no rollover. Monthly or annual billing does not change this schedule.</p>
                <p>Usage measurement is not available yet.</p>
              </> : <p>Weekly limits use a rolling seven-day window. Capacity returns as older usage leaves the window. Daily limits may also apply.</p>}
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
