import { useEffect, useRef, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { ExternalLink } from "lucide-react"
import { BillingWorkspaceDetails } from "@/components/org/BillingWorkspaceSummary"
import { getBillingWorkspace, startWorkspaceBillingPortal, type BillingWorkspace } from "@/lib/sync/billing-workspace"
import { billingOfferLabels } from "../../../db/shared/billing-offers"
import { BillingOffers } from "@/components/org/BillingOffers"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { SettingsBlock, SettingsGroup, SettingsRow } from "@/components/ui/page"
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
import { isTauriRuntime } from "@/lib/offline/is-tauri"
import { openExternal } from "@/lib/open-external"
import { ORG_SETTINGS_SECTION_DESCRIPTIONS, ORG_SETTINGS_SECTION_TITLES } from "./constants"
import { OrgSettingsDetailPage } from "./OrgSettingsDetailPage"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"

function planLabelKey(plan: OrgBilling["plan"]): MessageKey {
  const resolved = normalizeBillingPlan(plan)
  if (resolved === "field") return "billing.plan.field"
  if (resolved === "enterprise") return "billing.plan.enterprise"
  return "billing.plan.free"
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
  // Load failures are translated at render so the load effect does not depend on `t`.
  const [loadFailed, setLoadFailed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<"portal" | null>(null)

  const [searchParams, setSearchParams] = useSearchParams()
  const [notice, setNotice] = useState<MessageKey | null>(null)

  useEffect(() => {
    const checkout = searchParams.get("checkout")
    if (!["success", "cancel", "rehearsal"].includes(checkout ?? "")) return
    setNotice(checkout === "rehearsal" ? "billing.checkout.rehearsal" : checkout === "success" ? "billing.checkout.success" : "billing.checkout.canceled")
    const next = new URLSearchParams(searchParams)
    next.delete("checkout")
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  useEffect(() => {
    const generation = ++request.current
    setResult(null)
    setLoadFailed(false)
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
      if (request.current === generation) setLoadFailed(true)
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
      const url = paid && workspace?.portalEnabled === true
        ? await startWorkspaceBillingPortal(jwt, activeOrgId)
        : await startBillingPortal(jwt, activeOrgId)
      if (request.current !== generation) return
      await openExternal(url)
      // Desktop opens Stripe in the system browser and stays on this page.
      if (isTauriRuntime() && request.current === generation) setBusy(null)
    } catch (err) {
      if (request.current !== generation) return
      setError(err instanceof Error ? err.message : t("billing.portal.startFailed"))
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
          {t(notice)}
        </p>
      ) : null}

      {!canManage ? (
        <p className="text-sm text-muted-foreground">{t("billing.maintainersOnly")}</p>
      ) : pending || (!current && !error && !loadFailed) ? (
        <div className="flex items-center gap-2 text-muted-foreground" role="status">
          <Spinner className="size-3.5" />
          <span className="text-sm">{t("billing.loading")}</span>
        </div>
      ) : !workspace ? (
        <Button variant="outline" onClick={() => setReload(value => value + 1)}>{t("billing.retry")}</Button>
      ) : (
        <div className="flex flex-col gap-10">
          <SettingsGroup label={t("billing.plan.group")}>
            <SettingsRow
              label={t("billing.plan.current")}
              description={
                paid ? (paid.billingInterval === "year" ? t("billing.plan.billedAnnually") : t("billing.plan.billedMonthly"))
                  : data?.plan === "enterprise"
                  ? t("billing.plan.enterpriseHelp")
                  : t("billing.plan.coverageHelp")
              }
              control={
                <Badge variant={!paid && normalizeBillingPlan(data?.plan ?? "none") === "explore" ? "outline" : "default"} data-testid="billing-plan">
                  {paid ? billingOfferLabels[paid.offer] : t(planLabelKey(data!.plan))}
                </Badge>
              }
            />
            {(paid ? workspace.portalEnabled === true : data?.canManage) ? (
              <SettingsRow
                label={t("billing.plan.manage")}
                description={paid ? t("billing.plan.manageStripeHelp") : t("billing.plan.manageHelp")}
                control={
                  <Button
                    variant="outline"
                    onClick={() => void go("portal")}
                    disabled={busy != null}
                    data-testid="manage-billing"
                  >
                    <ExternalLink data-icon="inline-start" />
                    {busy === "portal" ? t("billing.portal.redirecting") : paid ? t("billing.portal.manage") : t("billing.portal.open")}
                  </Button>
                }
              />
            ) : null}
          </SettingsGroup>

          <Button className="self-start" variant="outline" onClick={() => setReload(value => value + 1)}>{t("billing.refresh")}</Button>
          <BillingWorkspaceDetails data={workspace} />
          {!paid && jwt && activeOrgId != null ? <BillingOffers key={activeOrgId} jwt={jwt} orgId={activeOrgId} /> : null}
          <SettingsGroup label={t("billing.coverage.title")}>
            <SettingsRow
              label={t("billing.coverage.etenQuestion")}
              description={t("billing.coverage.etenHelp")}
              control={
                <a
                  href="mailto:hello@aquilla.app?subject=ETEN%20affiliate%20or%20Bible-translation%20access"
                  className={cn(buttonVariants({ variant: "outline" }))}
                >
                  {t("billing.coverage.check")}
                </a>
              }
            />
            <SettingsRow
              label={t("billing.selection.compare")}
              description={t("billing.plans.compareHelp")}
              control={<a href="https://aquilla.app/pricing" className={cn(buttonVariants({ variant: "outline" }))}>{t("billing.plans.view")}</a>}
            />
          </SettingsGroup>
          <SettingsGroup label={t("billing.aiUsage.title")}>
            <SettingsBlock data-testid="billing-usage" className="flex flex-col gap-3 text-sm text-muted-foreground">
              <p>{t("billing.aiUsage.shared")}</p>
              {paid ? <>
                <p>{t("billing.aiUsage.paidReset")}</p>
                <p>{t("billing.aiUsage.notMeasured")}</p>
              </> : <p>{t("billing.aiUsage.rollingWindow")}</p>}
              <p>{t("billing.aiUsage.pauseNote")}</p>
              <p>{t("billing.aiUsage.noSelfService")}</p>
              <a href="mailto:support@aquilla.app?subject=Organization%20AI%20capacity" className="underline">{t("billing.aiUsage.contact")}</a>
            </SettingsBlock>
          </SettingsGroup>
        </div>
      )}

      {loadFailed || error ? (
        <p className="text-sm text-destructive" role="alert">
          {loadFailed ? t("billing.loadFailed") : error}
        </p>
      ) : null}
    </OrgSettingsDetailPage>
  )
}
