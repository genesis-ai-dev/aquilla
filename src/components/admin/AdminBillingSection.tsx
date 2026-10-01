import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { type ColumnDef } from "@tanstack/react-table"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/ui/data-table"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Section } from "@/components/ui/page"
import { DateTooltip } from "@/components/ui/date-tooltip"
import { OrgWithAvatar } from "@/components/OrgWithAvatar"
import { AdminSectionSkeleton } from "./shared"
import { formatAgentCredits, formatUsdFromCents, normalizeBillingPlan } from "@/lib/billing/plans"
import {
  getAdminBillingOrgs,
  getAdminBillingPlans,
  grantAdminCredits,
  grantAdminWords,
  patchAdminBillingOrg,
  resetAdminCredits,
  resetAdminWords,
  updateAdminBillingPlans,
  type AdminBillingOrg,
  type AdminBillingPlans,
} from "@/lib/frontier/admin"

/**
 * Platform billing: Field Plan catalog amounts + per-org grants/resets.
 * Dollar changes create a new Stripe Price when Stripe is configured;
 * usage grants never touch Stripe.
 */
export function AdminBillingSection({ jwt }: { jwt: string }) {
  const [catalog, setCatalog] = useState<AdminBillingPlans | null>(null)
  const [orgs, setOrgs] = useState<AdminBillingOrg[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const aliveRef = useRef(true)

  const [price, setPrice] = useState("")
  const [addonPrice, setAddonPrice] = useState("")
  const [wordsPerCredit, setWordsPerCredit] = useState("")
  const [exploreCredits, setExploreCredits] = useState("")
  const [fieldCredits, setFieldCredits] = useState("")
  const [addonCredits, setAddonCredits] = useState("")
  const [enterpriseCredits, setEnterpriseCredits] = useState("")

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [plans, rows] = await Promise.all([getAdminBillingPlans(jwt), getAdminBillingOrgs(jwt)])
      if (!aliveRef.current) return
      setCatalog(plans)
      setOrgs(rows)
      setPrice(String(plans.plan.priceCents / 100))
      setAddonPrice(String(plans.plan.addonPriceCents / 100))
      setWordsPerCredit(String(plans.plan.wordsPerCredit ?? 100))
      setExploreCredits(String(plans.plan.exploreCreditsPerCycle ?? 100))
      setFieldCredits(String(plans.plan.fieldCreditsPerCycle ?? 1_000))
      setAddonCredits(String(plans.plan.addonCredits ?? 1_000))
      setEnterpriseCredits(String(plans.plan.enterpriseCreditsPerLanguagePerYear ?? 10_000))
    } catch (err) {
      if (aliveRef.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (aliveRef.current) setLoading(false)
    }
  }, [jwt])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function saveCatalog() {
    if (!catalog) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const saved = await updateAdminBillingPlans(jwt, {
        ifMatchVersion: catalog.version,
        priceCents: Math.round(Number(price) * 100),
        addonPriceCents: Math.round(Number(addonPrice) * 100),
        wordsPerCredit: Math.round(Number(wordsPerCredit)),
        exploreCreditsPerCycle: Math.round(Number(exploreCredits)),
        fieldCreditsPerCycle: Math.round(Number(fieldCredits)),
        addonCredits: Math.round(Number(addonCredits)),
        enterpriseCreditsPerLanguagePerYear: Math.round(Number(enterpriseCredits)),
      })
      setCatalog({ ...catalog, plan: saved.plan, version: saved.version })
      setNotice(saved.warnings.length > 0 ? saved.warnings.join(" ") : "Catalog saved.")
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const act = useCallback(
    async (fn: () => Promise<void>) => {
      setError(null)
      setNotice(null)
      try {
        await fn()
        await refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [refresh],
  )

  const columns = useMemo<ColumnDef<AdminBillingOrg>[]>(
    () => [
      {
        id: "org",
        accessorFn: (row) => row.orgName ?? `#${row.orgId}`,
        header: "Org",
        cell: ({ row }) => (
          <div className="min-w-[120px]">
            <OrgWithAvatar name={row.original.orgName ?? `#${row.original.orgId}`} />
            <div className="pl-7 text-[10px] tabular-nums text-muted-foreground">#{row.original.orgId}</div>
          </div>
        ),
      },
      {
        id: "plan",
        header: "Plan",
        cell: ({ row }) => (
          <select
            aria-label={`plan for ${row.original.orgName ?? row.original.orgId}`}
            className="h-7 rounded-md border bg-background px-1.5 text-xs"
            value={normalizeBillingPlan(row.original.plan)}
            onChange={(e) => {
              const plan = e.target.value as AdminBillingOrg["plan"]
              void act(() => patchAdminBillingOrg(jwt, row.original.orgId, { plan }))
            }}
          >
            <option value="explore">Explore</option>
            <option value="field">Field</option>
            <option value="enterprise">Enterprise</option>
          </select>
        ),
      },
      {
        id: "usage",
        header: "Agent credits",
        cell: ({ row }) => (
          <div className="text-xs tabular-nums" data-testid={`admin-words-${row.original.orgId}`}>
            <span className="font-semibold">{formatAgentCredits(row.original.creditsUsed)}</span>
            <span className="text-muted-foreground"> / {formatAgentCredits(row.original.allowanceCredits)}</span>
            {normalizeBillingPlan(row.original.plan) === "enterprise" ? (
              <div className="text-[10px] text-muted-foreground">
                {row.original.languageCount} language{row.original.languageCount === 1 ? "" : "s"}
              </div>
            ) : null}
          </div>
        ),
      },
      {
        id: "override",
        header: "Override",
        cell: ({ row }) => (
          <OverrideCredits
            value={row.original.includedCreditsOverride}
            onCommit={(v) => void act(() => patchAdminBillingOrg(jwt, row.original.orgId, { includedCredits: v }))}
          />
        ),
      },
      {
        id: "comp",
        header: "Courtesy",
        cell: ({ row }) => (
          <span className="text-xs tabular-nums text-muted-foreground">
            {formatAgentCredits(row.original.complimentaryCredits)}
          </span>
        ),
      },
      {
        id: "period",
        header: "Capacity period",
        cell: ({ row }) => (
          <div className="text-xs text-muted-foreground" data-testid={`admin-period-${row.original.orgId}`}>
            {row.original.periodStart || row.original.periodEnd ? (
              <span className="flex items-center gap-1">
                <DateTooltip value={row.original.periodStart} label="Period start" />
                <span aria-hidden>→</span>
                <DateTooltip value={row.original.periodEnd} label="Period end" />
              </span>
            ) : (
              <span title="No billing period on record — the allowance applies to the current cycle.">
                No period set
              </span>
            )}
          </div>
        ),
      },
      {
        id: "actions",
        header: "Adjust",
        cell: ({ row }) => (
          <OrgActions
            org={row.original}
            onGrantWords={() =>
              void act(() =>
                grantAdminWords(
                  jwt,
                  row.original.orgId,
                  (row.original.wordsPerCredit || 100) * 1_000,
                  "admin courtesy grant",
                ),
              )
            }
            onResetWords={() =>
              void act(() => resetAdminWords(jwt, row.original.orgId, "admin usage reset"))
            }
            onGrantCredits={() =>
              void act(() => grantAdminCredits(jwt, row.original.orgId, 100, "admin courtesy grant"))
            }
            onResetCredits={() =>
              void act(() => resetAdminCredits(jwt, row.original.orgId, "admin credit reset"))
            }
          />
        ),
      },
    ],
    [act, jwt],
  )

  // AQU-942: only a first load that has resolved nothing may replace the
  // section. Every grant/reset/save round-trips through `refresh`, which flips
  // `loading` back on — gating on it alone unmounted the catalog form and the
  // org table after each action, losing the table's sort/scroll and flashing
  // the whole tab. Errors already render inline inside the shell below.
  if (loading && !catalog && !orgs) return <AdminSectionSkeleton label="Loading billing" />
  if (error && !catalog) return <p className="text-sm text-destructive">{error}</p>

  return (
    <div className="flex flex-col gap-8" data-testid="admin-billing">
      <Section
        title="Plan catalog"
        description="Included agent credits per tier. Users never see agent-processed words — only credits. Existing subscribers keep their Stripe price."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <AmountField label="Words per credit (internal)" value={wordsPerCredit} onChange={setWordsPerCredit} />
          <AmountField label="Explore credits / cycle" value={exploreCredits} onChange={setExploreCredits} />
          <AmountField label="Field credits / cycle" value={fieldCredits} onChange={setFieldCredits} />
          <AmountField label="Field Plan ($ / 4 weeks)" value={price} onChange={setPrice} />
          <AmountField label="Add-on credits / pack" value={addonCredits} onChange={setAddonCredits} />
          <AmountField label="Add-on ($ / pack)" value={addonPrice} onChange={setAddonPrice} />
          <AmountField label="Enterprise credits / language / year" value={enterpriseCredits} onChange={setEnterpriseCredits} />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={() => void saveCatalog()} disabled={busy || !catalog} data-testid="save-field-plan">
            {busy ? "Saving…" : "Save catalog"}
          </Button>
          {catalog ? (
            <p className="text-xs text-muted-foreground">
              {formatUsdFromCents(catalog.plan.priceCents)} · {formatAgentCredits(catalog.plan.fieldCreditsPerCycle ?? 1_000)} Field credits
              {catalog.stripeConfigured ? " · Stripe will mint a new price if the dollar amount changes" : " · Stripe not connected"}
            </p>
          ) : null}
        </div>
        {catalog ? <p className="mt-2 text-xs text-muted-foreground">{catalog.note}</p> : null}
      </Section>

      <Section title="Organizations" description="Override included agent credits, grant courtesy credits after an outage, or put an org on Explore / Field / Enterprise.">
        {orgs && orgs.length > 0 ? (
          <DataTable
            columns={columns}
            data={orgs}
            getRowId={(row) => String(row.orgId)}
            initialSorting={[{ id: "org", desc: false }]}
            searchPlaceholder="Search organizations…"
            globalFilterFn={(row, _columnId, filterValue) => {
              const q = String(filterValue).trim().toLowerCase()
              if (!q) return true
              const org = row.original
              return (
                (org.orgName ?? "").toLowerCase().includes(q) ||
                `#${org.orgId}`.includes(q) ||
                String(org.orgId).includes(q)
              )
            }}
            testId="admin-billing-orgs"
            rowClassName="align-top"
          />
        ) : (
          <p className="text-sm text-muted-foreground">No orgs found.</p>
        )}
      </Section>

      {notice ? (
        <p className="text-sm text-muted-foreground" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function OverrideCredits({
  value,
  onCommit,
}: {
  value: number | null
  onCommit: (v: number | null) => void
}) {
  const [local, setLocal] = useState(value == null ? "" : String(value))
  useEffect(() => {
    setLocal(value == null ? "" : String(value))
  }, [value])
  return (
    <Input
      type="number"
      min={0}
      aria-label="included credits override"
      placeholder="tier default"
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => {
        if (local.trim() === "") {
          if (value != null) onCommit(null)
          return
        }
        const n = Number(local)
        if (!Number.isNaN(n) && n >= 0 && n !== value) onCommit(n)
      }}
      className="h-7 w-24 text-xs tabular-nums"
    />
  )
}

function AmountField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <Label className="flex flex-col gap-1.5 text-xs">
      {label}
      <Input
        type="number"
        min={0}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 tabular-nums"
      />
    </Label>
  )
}

function OrgActions({
  org,
  onGrantWords,
  onResetWords,
  onGrantCredits,
  onResetCredits,
}: {
  org: AdminBillingOrg
  onGrantWords: () => void
  onResetWords: () => void
  onGrantCredits: () => void
  onResetCredits: () => void
}) {
  const [confirm, setConfirm] = useState<"words" | "credits" | null>(null)
  return (
    <div className="flex min-w-[220px] flex-col gap-1">
      <div className="flex flex-wrap gap-1">
        <Button size="sm" variant="outline" onClick={onGrantWords} data-testid={`grant-words-${org.orgId}`}>
          +1,000 agent credits
        </Button>
        <Button size="sm" variant="outline" onClick={onGrantCredits} data-testid={`grant-credits-${org.orgId}`}>
          +100 AI credits
        </Button>
      </div>
      {confirm == null ? (
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="ghost" onClick={() => setConfirm("words")}>
            Reset words
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirm("credits")}>
            Reset credits
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1">
          <Button
            size="sm"
            variant="destructive"
            onClick={() => {
              if (confirm === "words") onResetWords()
              else onResetCredits()
              setConfirm(null)
            }}
            data-testid={`confirm-reset-${confirm}-${org.orgId}`}
          >
            Confirm reset
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  )
}
