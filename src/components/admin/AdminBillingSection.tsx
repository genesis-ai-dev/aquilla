import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { type ColumnDef } from "@tanstack/react-table"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/ui/data-table"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Section } from "@/components/ui/page"
import { OrgWithAvatar } from "@/components/OrgWithAvatar"
import { formatUsdFromCents, formatWordCount } from "@/lib/billing/plans"
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
  const [included, setIncluded] = useState("")
  const [addonWords, setAddonWords] = useState("")
  const [talkToUs, setTalkToUs] = useState("")

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
      setIncluded(String(plans.plan.includedWords))
      setAddonWords(String(plans.plan.addonWords))
      setTalkToUs(String(plans.plan.talkToUsWordsPerYear))
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
        includedWords: Math.round(Number(included)),
        addonWords: Math.round(Number(addonWords)),
        talkToUsWordsPerYear: Math.round(Number(talkToUs)),
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
            value={row.original.plan}
            onChange={(e) => {
              const plan = e.target.value as AdminBillingOrg["plan"]
              void act(() => patchAdminBillingOrg(jwt, row.original.orgId, { plan }))
            }}
          >
            <option value="none">None</option>
            <option value="field">Field</option>
            <option value="enterprise">Enterprise</option>
          </select>
        ),
      },
      {
        id: "usage",
        header: "Words",
        cell: ({ row }) => (
          <div className="text-xs tabular-nums" data-testid={`admin-words-${row.original.orgId}`}>
            <span className="font-semibold">{formatWordCount(row.original.wordsUsed)}</span>
            <span className="text-muted-foreground">
              {row.original.allowanceWords == null ? " recorded" : ` / ${formatWordCount(row.original.allowanceWords)}`}
            </span>
          </div>
        ),
      },
      {
        id: "comp",
        header: "Courtesy",
        cell: ({ row }) => (
          <span className="text-xs tabular-nums text-muted-foreground">
            {formatWordCount(row.original.complimentaryWords)}
          </span>
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
                grantAdminWords(jwt, row.original.orgId, 100_000, "admin courtesy grant"),
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

  if (loading) return <p className="text-sm text-muted-foreground">Loading billing…</p>
  if (error && !catalog) return <p className="text-sm text-destructive">{error}</p>

  return (
    <div className="flex flex-col gap-8" data-testid="admin-billing">
      <Section
        title="Field Plan catalog"
        description="What new checkouts charge and how many words a period includes. Existing subscribers keep their Stripe price."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <AmountField label="Field Plan ($ / 4 weeks)" value={price} onChange={setPrice} />
          <AmountField label="Add-on ($ / pack)" value={addonPrice} onChange={setAddonPrice} />
          <AmountField label="Words included" value={included} onChange={setIncluded} />
          <AmountField label="Words per add-on" value={addonWords} onChange={setAddonWords} />
          <AmountField label="Talk-to-us words / year" value={talkToUs} onChange={setTalkToUs} />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={() => void saveCatalog()} disabled={busy || !catalog} data-testid="save-field-plan">
            {busy ? "Saving…" : "Save catalog"}
          </Button>
          {catalog ? (
            <p className="text-xs text-muted-foreground">
              {formatUsdFromCents(catalog.plan.priceCents)} · {formatWordCount(catalog.plan.includedWords)} words
              {catalog.stripeConfigured ? " · Stripe will mint a new price if the dollar amount changes" : " · Stripe not connected"}
            </p>
          ) : null}
        </div>
        {catalog ? <p className="mt-2 text-xs text-muted-foreground">{catalog.note}</p> : null}
      </Section>

      <Section title="Organizations" description="Grant words or credits after an outage, reset a period, or put an org on Field / Enterprise without Checkout.">
        {orgs && orgs.length > 0 ? (
          <DataTable
            columns={columns}
            data={orgs}
            getRowId={(row) => String(row.orgId)}
            initialSorting={[{ id: "org", desc: false }]}
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
          +100k words
        </Button>
        <Button size="sm" variant="outline" onClick={onGrantCredits} data-testid={`grant-credits-${org.orgId}`}>
          +100 credits
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
