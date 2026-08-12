/**
 * ProposalCard.tsx — staged agent proposal with Apply / Discard.
 *
 * One card per `proposal` SSE frame. Each staged event renders as a row:
 * canonicalRef, before → after (truncated with expand), and deterministic
 * lint badges from `checkRulesForCell` re-run client-side on the AFTER text
 * with the project's active rules (same rule list the editor's health pass
 * uses — pass `rules` from useRules).
 *
 * Apply pushes the staged events through the existing outbox write path
 * (src/lib/agent/apply.ts → enqueueEvent) authored by the CURRENT USER, then
 * reports back via `onApplied` so the workspace can flush + revalidate.
 * Role gate mirrors the server floors (src/lib/agent/role-floors.ts): Apply
 * is disabled with the reason inline when the user's role is provably below
 * the floor of any staged kind. Unknown kinds render as raw JSON with Apply
 * disabled ("not supported yet").
 */

import { useMemo, useState } from "react"
import { Check, ChevronDown, ChevronUp, MessageSquare, Pencil, ShieldCheck } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { Spinner } from "@/components/ui/spinner"
import type { TranslationRule, RuleInfraction } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import { checkRulesForCell } from "@/lib/rules/rule-engine"
import type { AgentProposal, StagedEvent } from "@/lib/agent/protocol"
import { applyStagedEvents, type ApplyContext } from "@/lib/agent/apply"
import { ValidationQueueCard } from "./cards/ValidationQueueCard"
import { isValidationProposal } from "./cards/registry"
import { canApply, isSupportedApplyKind } from "@/lib/agent/role-floors"
import { useT } from "@/lib/i18n/I18nProvider"

// ── Lint ───────────────────────────────────────────────────────────────────

/**
 * Build the CellData `checkRulesForCell` needs, with the staged AFTER text
 * in place of the current translation. Prefers the live cell (so
 * source-dependent rules see the real source text); falls back to a minimal
 * synthetic cell when the projection hasn't loaded that cell.
 *
 * Exported for the workbench's working set, which lints the row's CURRENT
 * text (the user may have edited the draft) — pass it as `afterOverride`.
 */
export function lintCellFor(
  ev: StagedEvent,
  resolveCell: ((cellId: string) => CellData | undefined) | undefined,
  afterOverride?: string,
): CellData {
  const after = afterOverride ?? ev.display.after ?? ""
  const live = ev.cellId ? resolveCell?.(ev.cellId) : undefined
  const base: CellData =
    live ??
    ({
      id: ev.cellId ?? "agent-staged",
      fileId: ev.fileId ?? "",
      original: ev.display.before ?? "",
      translated: "",
      context: "",
      group: ev.display.canonicalRef ?? "",
      type: "text",
      status: "empty",
      validationStatus: "empty",
      activeValidators: [],
      validationHistory: [],
      history: [],
      threads: [],
    } satisfies CellData)
  return {
    ...base,
    translated: after,
    translatedHtml: undefined,
    status: after.trim() ? "unvalidated" : "empty",
  }
}

// ── Per-event row ──────────────────────────────────────────────────────────

const TRUNCATE_AT = 160

function TruncatableText({ text, className }: { text: string; className?: string }) {
  const [expanded, setExpanded] = useState(false)
  const needsTruncation = text.length > TRUNCATE_AT
  const shown = expanded || !needsTruncation ? text : `${text.slice(0, TRUNCATE_AT)}…`
  return (
    <span className={className}>
      {shown}
      {needsTruncation && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="ml-1 inline-flex items-center align-baseline text-[10px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          {expanded ? (
            <>Show less <ChevronUp className="ml-0.5 h-2.5 w-2.5" /></>
          ) : (
            <>Show more <ChevronDown className="ml-0.5 h-2.5 w-2.5" /></>
          )}
        </button>
      )}
    </span>
  )
}

const KIND_META: Record<string, { label: string; Icon: typeof Pencil }> = {
  "target.cell.commit": { label: "Edit", Icon: Pencil },
  "comment.create": { label: "Comment", Icon: MessageSquare },
  "cell.validate": { label: "Validate", Icon: ShieldCheck },
}

function StagedEventRow({
  ev,
  infractions,
}: {
  ev: StagedEvent
  infractions: RuleInfraction[]
}) {
  const meta = KIND_META[ev.kind]

  if (!meta) {
    // Unknown kind — show it honestly rather than guessing a rendering.
    return (
      <div className="space-y-1 rounded-md border border-dashed px-2 py-1.5">
        <div className="flex items-center gap-1.5 text-[11px]">
          <Badge variant="outline" className="px-1.5 py-0 font-mono text-[10px]">{ev.kind}</Badge>
          <span className="text-muted-foreground">not supported yet — apply this kind in the app directly</span>
        </div>
        <pre className="overflow-x-auto font-mono text-[10px] leading-relaxed text-muted-foreground">
          {JSON.stringify(ev, null, 2)}
        </pre>
      </div>
    )
  }

  const { label, Icon } = meta
  const body =
    ev.kind === "comment.create" && typeof ev.payload.body === "string"
      ? ev.payload.body
      : undefined

  return (
    <div className="space-y-1 rounded-md border px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="font-medium">{label}</span>
        {ev.display.canonicalRef && (
          <Badge variant="secondary" className="px-1.5 py-0 font-mono text-[10px]">
            {ev.display.canonicalRef}
          </Badge>
        )}
        {infractions.map((inf) => (
          <Badge key={inf.ruleId} variant="destructive" className="px-1.5 py-0 text-[10px]">
            {inf.message}
          </Badge>
        ))}
      </div>

      {ev.kind === "target.cell.commit" && (
        <div className="space-y-0.5 text-xs">
          {ev.display.before ? (
            <div className="text-muted-foreground line-through decoration-muted-foreground/50">
              <TruncatableText text={ev.display.before} />
            </div>
          ) : (
            <div className="text-[10px] italic text-muted-foreground">(currently empty)</div>
          )}
          <div>
            <TruncatableText text={ev.display.after ?? ""} />
          </div>
        </div>
      )}

      {ev.kind === "comment.create" && body !== undefined && (
        <div className="text-xs">
          <TruncatableText text={body} />
        </div>
      )}

      {ev.kind === "cell.validate" && ev.display.after && (
        <div className="text-xs text-muted-foreground">
          <TruncatableText text={ev.display.after} />
        </div>
      )}
    </div>
  )
}

// ── Card ───────────────────────────────────────────────────────────────────

export interface ProposalCardProps {
  proposal: AgentProposal
  /** Current user's project role level (project.syncRole.level); null = unknown. */
  roleLevel: number | null
  /** Project's active rules — same list the editor's health pass consumes. */
  rules: TranslationRule[]
  /** Live cell lookup from useCells, for lint context + fresh chain heads. */
  resolveCell?: (cellId: string) => CellData | undefined
  /** Write-path context (projectId + current user as author). */
  applyContext: ApplyContext
  /** Called after a successful apply so the caller can flush + revalidate. */
  onApplied?: (eventIds: string[], cellIds: string[]) => void | Promise<void>
}

type CardState = "idle" | "applying" | "applied" | "discarded"

export function ProposalCard({
  proposal,
  roleLevel,
  rules,
  resolveCell,
  applyContext,
  onApplied,
}: ProposalCardProps) {
  const t = useT()
  // Tier 2 (testimony): all-validation proposals get the per-item queue —
  // one Confirm per cell, no apply-all (agent-complete design §3/§6).
  // Before any hooks: a proposal's composition never changes, but React
  // still wants an unconditional hook order per code path.
  if (isValidationProposal(proposal)) {
    return (
      <ValidationQueueCard
        proposal={proposal}
        applyContext={applyContext}
        onApplied={onApplied}
        canValidate={canApply(t, "cell.validate", roleLevel).allowed}
      />
    )
  }
  return <StagedProposalCard proposal={proposal} roleLevel={roleLevel} rules={rules} resolveCell={resolveCell} applyContext={applyContext} onApplied={onApplied} />
}

/** The generic staged-diff card (tier 1 / mixed proposals). */
function StagedProposalCard({
  proposal,
  roleLevel,
  rules,
  resolveCell,
  applyContext,
  onApplied,
}: ProposalCardProps) {
  const t = useT()
  const [state, setState] = useState<CardState>("idle")
  const [applyError, setApplyError] = useState<string | null>(null)

  const enabledRules = useMemo(() => rules.filter((r) => r.enabled), [rules])

  // Deterministic lint on every commit's AFTER text, before any apply.
  const lintByIndex = useMemo(() => {
    const out = new Map<number, RuleInfraction[]>()
    proposal.events.forEach((ev, i) => {
      if (ev.kind !== "target.cell.commit") return
      if (enabledRules.length === 0) return
      const cell = lintCellFor(ev, resolveCell)
      out.set(i, checkRulesForCell(cell, ev.fileId ?? "", enabledRules))
    })
    return out
  }, [proposal.events, enabledRules, resolveCell])

  const hasUnsupported = proposal.events.some((ev) => !isSupportedApplyKind(ev.kind))
  const roleBlock = useMemo(() => {
    for (const ev of proposal.events) {
      const verdict = canApply(t, ev.kind, roleLevel)
      if (!verdict.allowed) return verdict
    }
    return null
  }, [proposal.events, roleLevel, t])

  const blockedReason = hasUnsupported
    ? "Contains event kinds this app can't apply yet"
    : roleBlock?.reason ?? null

  async function handleApply() {
    if (state !== "idle" || blockedReason) return
    setState("applying")
    setApplyError(null)
    try {
      const eventIds = await applyStagedEvents(proposal.events, applyContext)
      setState("applied")
      const cellIds = proposal.events
        .map((ev) => ev.cellId)
        .filter((id): id is string => Boolean(id))
      await onApplied?.(eventIds, [...new Set(cellIds)])
    } catch (err) {
      setState("idle")
      setApplyError(err instanceof Error ? err.message : String(err))
    }
  }

  if (state === "discarded") {
    return (
      <div className="rounded-lg border border-dashed px-2.5 py-1.5 text-[11px] text-muted-foreground">
        Discarded: {proposal.summary}
      </div>
    )
  }

  return (
    <div className="space-y-2 rounded-lg border bg-card px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{proposal.summary}</span>
        <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
          {proposal.events.length} {proposal.events.length === 1 ? "change" : "changes"}
        </Badge>
      </div>

      <div className="space-y-1.5">
        {proposal.events.map((ev, i) => (
          <StagedEventRow
            key={`${proposal.proposalId}-${i}`}
            ev={ev}
            infractions={lintByIndex.get(i) ?? []}
          />
        ))}
      </div>

      {applyError && (
        <div className="text-[11px] text-destructive">Apply failed: {applyError}</div>
      )}

      {state === "applied" ? (
        <div className="flex items-center gap-1 text-[11px] font-medium text-emerald-600">
          <Check className="h-3 w-3" /> Applied
        </div>
      ) : (
        <div className="space-y-1">
          <div className="flex items-center justify-end gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[11px]"
              onClick={() => setState("discarded")}
              disabled={state === "applying"}
            >
              Discard
            </Button>
            <AppTooltip content={blockedReason ?? undefined} disabled={!blockedReason}>
              <Button
                size="sm"
                className="h-6 text-[11px]"
                onClick={() => void handleApply()}
                disabled={Boolean(blockedReason) || state === "applying"}
              >
              {state === "applying" ? (
                <>
                  <Spinner className="size-3" /> Applying…
                </>
              ) : (
                "Apply"
              )}
            </Button>
            </AppTooltip>
          </div>
          {blockedReason && (
            <div className="text-right text-[10px] text-muted-foreground">{blockedReason}</div>
          )}
        </div>
      )}
    </div>
  )
}
