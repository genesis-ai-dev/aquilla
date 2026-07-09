import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { type ColumnDef } from "@tanstack/react-table"
import {
  listOrgCredits,
  setOrgCreditConfig,
  type AdminOrgCredits,
  type CreditConfigPatch,
} from "@/lib/sync/credits"
import { formatCredits, capUsagePct } from "@/lib/credits"
import { SegmentedCapBar, RailLegend } from "@/components/credits/credit-visuals"
import { pctTextClass } from "@/components/credits/rails"
import { DataTable } from "@/components/ui/data-table"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"

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
    return () => {
      aliveRef.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    if (aliveRef.current) {
      setLoading(true)
      setError(null)
    }
    try {
      const data = await listOrgCredits(jwt)
      if (aliveRef.current) setRows(data)
    } catch (err) {
      if (aliveRef.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (aliveRef.current) setLoading(false)
    }
  }, [jwt])

  useEffect(() => {
    void refresh()
  }, [refresh])

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

  const columns = useMemo<ColumnDef<AdminOrgCredits>[]>(
    () => [
      {
        id: "org",
        accessorFn: (row) => row.orgName ?? `#${row.orgId}`,
        header: "Org",
        cell: ({ row }) => (
          <div>
            <div className="min-w-[120px] font-medium">
              {row.original.orgName ?? `#${row.original.orgId}`}
            </div>
            <div className="text-[10px] tabular-nums text-muted-foreground">
              #{row.original.orgId}
            </div>
          </div>
        ),
      },
      {
        id: "today",
        header: () => (
          <span title="Total spend today across all rails (agent + chat + TTS).">Today</span>
        ),
        cell: ({ row }) => (
          <SpendWindow
            total={row.original.day.totalCredits}
            cap={row.original.config.dailyCap}
            byRail={row.original.day.byRail}
            agentTestId={`agent-day-${row.original.orgId}`}
            totalTestId={`cap-day-${row.original.orgId}`}
          />
        ),
      },
      {
        id: "week",
        header: () => (
          <span title="Total spend this week across all rails.">This week</span>
        ),
        cell: ({ row }) => (
          <SpendWindow
            total={row.original.week.totalCredits}
            cap={row.original.config.weeklyCap}
            byRail={row.original.week.byRail}
            agentTestId={`agent-week-${row.original.orgId}`}
            totalTestId={`cap-week-${row.original.orgId}`}
          />
        ),
      },
      {
        id: "caps",
        header: "Caps",
        cell: ({ row }) => (
          <div className="flex flex-col gap-1.5">
            <CapInput
              value={row.original.config.dailyCap}
              onCommit={(v) => void patch(row.original.orgId, { dailyCap: v })}
              label="daily cap"
              prefix="Day"
            />
            <CapInput
              value={row.original.config.weeklyCap}
              onCommit={(v) => void patch(row.original.orgId, { weeklyCap: v })}
              label="weekly cap"
              prefix="Wk"
            />
          </div>
        ),
      },
      {
        id: "controls",
        header: "Controls",
        cell: ({ row }) => (
          <div className="flex flex-col gap-1.5">
            <Toggle
              checked={row.original.config.enforce}
              onChange={(v) => void patch(row.original.orgId, { enforce: v })}
              label="enforce caps"
              caption="Enforce"
              testId={`enforce-toggle-${row.original.orgId}`}
            />
            <Toggle
              checked={row.original.config.showToOrg}
              onChange={(v) => void patch(row.original.orgId, { showToOrg: v })}
              label="show to org maintainers"
              caption="Show org"
              testId={`show-org-toggle-${row.original.orgId}`}
            />
          </div>
        ),
      },
    ],
    [patch],
  )

  if (loading) return <p className="text-sm text-muted-foreground">Loading credits…</p>
  if (error) return <p className="text-sm text-destructive">{error}</p>
  if (rows === null) return <p className="text-sm text-muted-foreground">No credits data available.</p>
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No orgs found.</p>

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>Credit = 1¢ customer price · agent rail 5× markup, others 4×.</span>
        <span className="inline-flex items-center gap-3">
          <RailKey label="Agent" dot="bg-amber-500" />
          <RailKey label="Chat" dot="bg-sky-500" />
          <RailKey label="TTS" dot="bg-violet-500" />
        </span>
      </div>
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(row) => String(row.orgId)}
        testId="admin-credits-table"
        rowClassName="align-top"
      />
    </div>
  )
}

function RailKey({ label, dot }: { label: string; dot: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`size-1.5 rounded-full ${dot}`} />
      {label}
    </span>
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
    <div className="flex min-w-[150px] flex-col gap-1.5">
      <div
        className="flex items-baseline justify-between gap-2 text-xs tabular-nums"
        data-testid={totalTestId}
      >
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

  useEffect(() => {
    setLocal(String(value))
  }, [value])

  return (
    <Label className="flex items-center gap-1.5">
      {prefix ? (
        <span className="w-6 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
          {prefix}
        </span>
      ) : null}
      <Input
        type="number"
        aria-label={label}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => {
          const n = Number(local)
          if (!Number.isNaN(n) && n >= 0 && n !== value) onCommit(n)
        }}
        className="h-7 w-20 text-xs tabular-nums"
        min={0}
      />
    </Label>
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
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        aria-label={label}
        data-testid={testId}
        size="sm"
      />
      {caption ? <span className="text-[11px] text-muted-foreground">{caption}</span> : null}
    </div>
  )
}
