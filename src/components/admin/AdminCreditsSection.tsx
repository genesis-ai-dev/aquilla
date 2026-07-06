import { useCallback, useEffect, useRef, useState } from "react"
import {
  listOrgCredits,
  setOrgCreditConfig,
  type AdminOrgCredits,
  type CreditConfigPatch,
} from "@/lib/sync/credits"
import { formatCredits, capUsagePct } from "@/lib/credits"

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
      <p className="text-xs text-muted-foreground">
        Credit = 1¢ customer-facing price. Agent rail uses elevated markup (5×).
        Caps are advisory when enforce is off (log + display only).
      </p>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm" data-testid="admin-credits-table">
          <thead>
            <tr className="bg-muted/40 text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">Org</th>
              <th className="px-3 py-2 font-medium" title="Total spend today, all rails (agent + chat + TTS).">
                Day spend
              </th>
              <th className="px-3 py-2 font-medium text-amber-700 dark:text-amber-400" title="Agent-only spend today — already included in Day spend, broken out for visibility.">
                Agent (day)
              </th>
              <th className="px-3 py-2 font-medium" title="Total spend this week, all rails (agent + chat + TTS).">
                Week spend
              </th>
              <th className="px-3 py-2 font-medium text-amber-700 dark:text-amber-400" title="Agent-only spend this week — already included in Week spend, broken out for visibility.">
                Agent (wk)
              </th>
              <th className="px-3 py-2 font-medium">Daily cap</th>
              <th className="px-3 py-2 font-medium">Weekly cap</th>
              <th className="px-3 py-2 font-medium">Enforce</th>
              <th className="px-3 py-2 font-medium">Show org</th>
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

function AdminCreditsRow({
  row,
  onPatch,
}: {
  row: AdminOrgCredits
  onPatch: (orgId: number, patch: CreditConfigPatch) => Promise<void>
}) {
  const dayPct = capUsagePct(row.day.totalCredits, row.config.dailyCap)
  const weekPct = capUsagePct(row.week.totalCredits, row.config.weeklyCap)
  const agentDayPct = capUsagePct(row.day.agentCredits, row.config.agentDailyCap)
  const agentWeekPct = capUsagePct(row.week.agentCredits, row.config.agentWeeklyCap)

  return (
    <tr className="border-t align-top">
      {/* Org name */}
      <td className="px-3 py-2 font-medium">{row.orgName ?? `#${row.orgId}`}</td>

      {/* Daily total spend + bar */}
      <td className="px-3 py-2">
        <SpendCell credits={row.day.totalCredits} pct={dayPct} />
      </td>

      {/* Agent day spend — highlighted as the dangerous rail */}
      <td className="px-3 py-2 bg-amber-50/60 dark:bg-amber-950/30" data-testid={`agent-day-${row.orgId}`}>
        <SpendCell credits={row.day.agentCredits} pct={agentDayPct} variant="agent" />
      </td>

      {/* Weekly total spend + bar */}
      <td className="px-3 py-2">
        <SpendCell credits={row.week.totalCredits} pct={weekPct} />
      </td>

      {/* Agent week spend — highlighted */}
      <td className="px-3 py-2 bg-amber-50/60 dark:bg-amber-950/30" data-testid={`agent-week-${row.orgId}`}>
        <SpendCell credits={row.week.agentCredits} pct={agentWeekPct} variant="agent" />
      </td>

      {/* Editable daily cap */}
      <td className="px-3 py-2">
        <CapInput
          value={row.config.dailyCap}
          onCommit={(v) => onPatch(row.orgId, { dailyCap: v })}
          label="daily cap"
        />
      </td>

      {/* Editable weekly cap */}
      <td className="px-3 py-2">
        <CapInput
          value={row.config.weeklyCap}
          onCommit={(v) => onPatch(row.orgId, { weeklyCap: v })}
          label="weekly cap"
        />
      </td>

      {/* Enforce toggle */}
      <td className="px-3 py-2">
        <Toggle
          checked={row.config.enforce}
          onChange={(v) => onPatch(row.orgId, { enforce: v })}
          label="enforce caps"
          testId={`enforce-toggle-${row.orgId}`}
        />
      </td>

      {/* showToOrg toggle */}
      <td className="px-3 py-2">
        <Toggle
          checked={row.config.showToOrg}
          onChange={(v) => onPatch(row.orgId, { showToOrg: v })}
          label="show to org maintainers"
          testId={`show-org-toggle-${row.orgId}`}
        />
      </td>
    </tr>
  )
}

function SpendCell({
  credits,
  pct,
  variant = "default",
}: {
  credits: number
  pct: number
  variant?: "default" | "agent"
}) {
  const barColor =
    pct >= 90
      ? "bg-destructive"
      : pct >= 70
        ? "bg-amber-500"
        : variant === "agent"
          ? "bg-amber-400"
          : "bg-primary"

  return (
    <div className="min-w-[80px]">
      <p className="text-xs tabular-nums font-medium">{formatCredits(credits)}</p>
      <div className="mt-0.5 h-1 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full ${barColor}`}
          style={{ width: `${pct}%` }}
          aria-label={`${pct}%`}
        />
      </div>
      <p className="mt-0.5 text-[10px] text-muted-foreground tabular-nums">{pct}%</p>
    </div>
  )
}

function CapInput({
  value,
  onCommit,
  label,
}: {
  value: number
  onCommit: (v: number) => void
  label: string
}) {
  const [local, setLocal] = useState(String(value))

  // Keep local in sync if the row refreshes from server
  useEffect(() => { setLocal(String(value)) }, [value])

  return (
    <input
      type="number"
      aria-label={label}
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => {
        const n = Number(local)
        if (!Number.isNaN(n) && n >= 0 && n !== value) onCommit(n)
      }}
      className="w-20 rounded border bg-background px-2 py-0.5 text-xs tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      min={0}
    />
  )
}

function Toggle({
  checked,
  onChange,
  label,
  testId,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  testId: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
        checked ? "bg-primary" : "bg-muted"
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </button>
  )
}
