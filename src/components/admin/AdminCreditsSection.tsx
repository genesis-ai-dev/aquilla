import { useCallback, useEffect, useRef, useState } from "react"
import {
  listOrgCredits,
  setOrgCreditConfig,
  type AdminOrgCredits,
  type CreditConfigPatch,
} from "@/lib/sync/credits"
import { formatCredits, capUsagePct } from "@/lib/credits"
import { SegmentedCapBar, RailLegend } from "@/components/credits/credit-visuals"
import { pctTextClass } from "@/components/credits/rails"

/**
 * Platform-admin "Compute / Credits" section for the AdminConsole.
 *
 * Per-org table showing:
 *   - Daily & weekly credit spend (total + agent sub-spend highlighted)
 *   - Cap bars with % used
 *   - Editable caps + markup (inline inputs, saved on blur)
 *   - enforce toggle (log-only vs. hard-blocking)
 *   - showToOrg toggle (reveal panel to org maintainers)
 *
 * Platform-admin gate is enforced by AdminConsole — this component assumes
 * its parent has verified access; the server re-enforces on every API call.
 *
 * WHY agent is visually highlighted: agent runs are the most expensive and
 * least predictable rail. A single runaway agent session can exhaust a weekly
 * budget in minutes. Highlighting surfaces that risk to the platform operator.
 */
export function AdminCreditsSection({ jwt }: { jwt: string }) {
  const [rows, setRows] = useState<AdminOrgCredits[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  const refresh = useCallback(async () => {
    if (aliveRef.current) { setLoading(true); setError(null) }
    try {
      const data = await listOrgCredits(jwt)
      if (aliveRef.current) setRows(data)
    } catch (err) {
      if (aliveRef.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (aliveRef.current) setLoading(false)
    }
  }, [jwt])

  useEffect(() => { void refresh() }, [refresh])

  const patch = useCallback(
    async (orgId: number, update: CreditConfigPatch) => {
      try {
        await setOrgCreditConfig(jwt, orgId, update)
        await refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [jwt, refresh],
  )

  if (loading) return <p className="text-sm text-muted-foreground">Loading credits…</p>
  if (error) return <p className="text-sm text-destructive">{error}</p>
  if (rows === null) return <p className="text-sm text-muted-foreground">No credits data available.</p>
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No orgs found.</p>

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>Credit = 1¢ customer price · agent rail 5× markup, others 4×.</span>
        <span className="inline-flex items-center gap-3">
          <RailKey label="Agent" dot="bg-amber-500" />
          <RailKey label="Chat" dot="bg-sky-500" />
          <RailKey label="TTS" dot="bg-violet-500" />
        </span>
      </div>
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm" data-testid="admin-credits-table">
          <thead>
            <tr className="border-b bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2 font-medium">Org</th>
              <th className="px-3 py-2 font-medium" title="Total spend today across all rails (agent + chat + TTS).">
                Today
              </th>
              <th className="px-3 py-2 font-medium" title="Total spend this week across all rails.">
                This week
              </th>
              <th className="px-3 py-2 font-medium">Caps</th>
              <th className="px-3 py-2 font-medium">Controls</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <AdminCreditsRow key={row.orgId} row={row} onPatch={patch} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function RailKey({ label, dot }: { label: string; dot: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  )
}

function AdminCreditsRow({
  row,
  onPatch,
}: {
  row: AdminOrgCredits
  onPatch: (orgId: number, patch: CreditConfigPatch) => Promise<void>
}) {
  return (
    <tr className="border-t align-top">
      {/* Org name */}
      <td className="px-3 py-3 font-medium">
        <div className="min-w-[120px]">{row.orgName ?? `#${row.orgId}`}</div>
        <div className="text-[10px] text-muted-foreground tabular-nums">#{row.orgId}</div>
      </td>

      {/* Today — total vs cap + segmented rail bar + legend */}
      <td className="px-3 py-3">
        <SpendWindow
          total={row.day.totalCredits}
          cap={row.config.dailyCap}
          byRail={row.day.byRail}
          agentTestId={`agent-day-${row.orgId}`}
          totalTestId={`cap-day-${row.orgId}`}
        />
      </td>

      {/* This week */}
      <td className="px-3 py-3">
        <SpendWindow
          total={row.week.totalCredits}
          cap={row.config.weeklyCap}
          byRail={row.week.byRail}
          agentTestId={`agent-week-${row.orgId}`}
          totalTestId={`cap-week-${row.orgId}`}
        />
      </td>

      {/* Editable caps (daily / weekly) */}
      <td className="px-3 py-3">
        <div className="space-y-1.5">
          <CapInput
            value={row.config.dailyCap}
            onCommit={(v) => onPatch(row.orgId, { dailyCap: v })}
            label="daily cap"
            prefix="Day"
          />
          <CapInput
            value={row.config.weeklyCap}
            onCommit={(v) => onPatch(row.orgId, { weeklyCap: v })}
            label="weekly cap"
            prefix="Wk"
          />
        </div>
      </td>

      {/* Controls (enforce / show to org) */}
      <td className="px-3 py-3">
        <div className="space-y-1.5">
          <Toggle
            checked={row.config.enforce}
            onChange={(v) => onPatch(row.orgId, { enforce: v })}
            label="enforce caps"
            caption="Enforce"
            testId={`enforce-toggle-${row.orgId}`}
          />
          <Toggle
            checked={row.config.showToOrg}
            onChange={(v) => onPatch(row.orgId, { showToOrg: v })}
            label="show to org maintainers"
            caption="Show org"
            testId={`show-org-toggle-${row.orgId}`}
          />
        </div>
      </td>
    </tr>
  )
}

/** One spend window in the admin table: total/cap + % + segmented rail bar +
 *  legend. The agent chip carries `agentTestId` so the FRO-414 anti-transposition
 *  tests can pin the agent value distinctly from the total. */
function SpendWindow({
  total,
  cap,
  byRail,
  agentTestId,
  totalTestId,
}: {
  total: number
  cap: number
  byRail: Record<string, number>
  agentTestId: string
  totalTestId: string
}) {
  const pct = capUsagePct(total, cap)
  return (
    <div className="min-w-[150px] space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-xs tabular-nums" data-testid={totalTestId}>
        <span className="font-semibold">{formatCredits(total)}</span>
        <span className={`font-medium ${pctTextClass(pct)}`}>{pct}%</span>
      </div>
      <SegmentedCapBar byRail={byRail} cap={cap} className="h-1.5" />
      <RailLegend byRail={byRail} chipTestId={(rail) => (rail === "agent" ? agentTestId : undefined)} />
    </div>
  )
}

function CapInput({
  value,
  onCommit,
  label,
  prefix,
}: {
  value: number
  onCommit: (v: number) => void
  label: string
  /** Short caption shown before the input (e.g. "Day", "Wk"). */
  prefix?: string
}) {
  const [local, setLocal] = useState(String(value))

  // Keep local in sync if the row refreshes from server
  useEffect(() => { setLocal(String(value)) }, [value])

  return (
    <label className="flex items-center gap-1.5">
      {prefix ? (
        <span className="w-6 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">{prefix}</span>
      ) : null}
      <input
        type="number"
        aria-label={label}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => {
          const n = Number(local)
          if (!Number.isNaN(n) && n >= 0 && n !== value) onCommit(n)
        }}
        className="w-20 rounded-md border bg-background px-2 py-0.5 text-xs tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        min={0}
      />
    </label>
  )
}

function Toggle({
  checked,
  onChange,
  label,
  caption,
  testId,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  /** Inline caption shown next to the switch (e.g. "Enforce"). */
  caption?: string
  testId: string
}) {
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        data-testid={testId}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
          checked ? "bg-primary" : "bg-muted"
        }`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
            checked ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </button>
      {caption ? <span className="text-[11px] text-muted-foreground">{caption}</span> : null}
    </div>
  )
}
