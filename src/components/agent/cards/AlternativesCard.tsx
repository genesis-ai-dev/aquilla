/**
 * AlternativesCard — several staged wordings of ONE cell, of which the
 * reviewer picks exactly one (AQU-2398).
 *
 * The ordinary proposal card applies every staged event together, and
 * applyStagedEvents CHAINS two commits to the same cell, so an apply-all over
 * N alternative wordings would write all N and leave the last. That is the
 * opposite of a choice. This card therefore applies exactly ONE event — the
 * chosen wording — and the rest are discarded unwritten: they go nowhere, and
 * because Living Memory examples are drawn from validated cells, an unchosen
 * wording can never become one.
 *
 * Nothing here validates anything. Picking a wording stages a
 * target.cell.commit and nothing else, so the cell lands as an unreviewed AI
 * draft exactly as a single agent draft does.
 */

import { useState } from "react"
import { Check, Sparkles } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { Spinner } from "@/components/ui/spinner"
import { InlineAiError } from "@/components/InlineAiError"
import { useT } from "@/lib/i18n/I18nProvider"
import { applyStagedEvent, type ApplyContext } from "@/lib/agent/apply"
import type { AgentProposal } from "@/lib/agent/protocol"
import type { CellData } from "@/hooks/useCells"
import type { RuleInfraction, TranslationRule } from "@/lib/parsers/types"
import { checkRulesForCell } from "@/lib/rules/rule-engine"
import { translateRuleName } from "@/lib/lqa/builtin-resolver"
import { formatInfractionMessage } from "@/lib/rules/format-infraction"
import { lintCellFor } from "../ProposalCard"

export interface AlternativesCardProps {
  proposal: AgentProposal
  /** Project's active rules — every option is linted, same as a staged diff. */
  rules: TranslationRule[]
  /** Live cell lookup from useCells, for lint context + fresh chain heads. */
  resolveCell?: (cellId: string) => CellData | undefined
  applyContext: ApplyContext
  /** Post-apply hook (flush outbox + revalidate), same as ProposalCard's. */
  onApplied?: (eventIds: string[], cellIds: string[]) => void | Promise<void>
  /** Role-gate reason, or null when the reader may commit. Server stays authoritative. */
  blockedReason?: string | null
}

type CardState = "idle" | "applying" | "applied" | "discarded"

export function AlternativesCard({
  proposal,
  rules,
  resolveCell,
  applyContext,
  onApplied,
  blockedReason,
}: AlternativesCardProps) {
  const t = useT()
  const [state, setState] = useState<CardState>("idle")
  const [chosen, setChosen] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const options = proposal.events
  const first = options[0]
  const before = first.display.before ?? ""
  const enabledRules = rules.filter((r) => r.enabled)
  const ruleById = new Map(rules.map((r) => [r.id, r]))

  const lintFor = (index: number): RuleInfraction[] => {
    if (enabledRules.length === 0) return []
    const ev = options[index]
    return checkRulesForCell(lintCellFor(ev, resolveCell), ev.fileId ?? "", enabledRules)
  }

  async function choose(index: number) {
    if (state !== "idle" || blockedReason) return
    setState("applying")
    setChosen(index)
    setError(null)
    try {
      const ev = options[index]
      const eventId = await applyStagedEvent(ev, applyContext)
      setState("applied")
      if (ev.cellId) await onApplied?.([eventId], [ev.cellId])
    } catch (err) {
      // The pick is not kept on failure: the reader may want a different one.
      setState("idle")
      setChosen(null)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (state === "discarded") {
    return (
      <div className="rounded-lg border border-dashed px-2.5 py-1.5 text-[11px] text-muted-foreground">
        {t("agent.alternatives.discarded")}
      </div>
    )
  }

  return (
    <div className="my-1.5 space-y-2 rounded-lg border bg-card px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {t("agent.alternatives.title", { count: options.length })}
        </span>
        {first.display.canonicalRef && (
          <Badge variant="secondary" className="shrink-0 px-1.5 py-0 font-mono text-[10px]">
            {first.display.canonicalRef}
          </Badge>
        )}
      </div>

      {/* The contract, stated where the decision happens: one of these is
          written, the others are thrown away. */}
      <p className="text-[10px] text-muted-foreground">{t("agent.alternatives.pickOneNotice")}</p>

      {before ? (
        <div className="rounded-md border border-dashed px-2 py-1 text-xs">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {t("agent.alternatives.currentText")}
          </div>
          <div dir="auto" className="whitespace-pre-wrap break-words text-muted-foreground">
            {before}
          </div>
        </div>
      ) : (
        <div className="text-[10px] italic text-muted-foreground">{t("autopilot.proposal.currentlyEmpty")}</div>
      )}

      <ul className="space-y-1.5">
        {options.map((ev, i) => {
          const infractions = lintFor(i)
          const isChosen = chosen === i
          const applied = state === "applied"
          return (
            <li
              key={`${proposal.proposalId}-alt-${i}`}
              className={`space-y-1 rounded-md border px-2 py-1.5 ${
                applied && isChosen ? "border-emerald-300 bg-emerald-50 dark:border-emerald-900/50 dark:bg-emerald-950/20" : ""
              } ${applied && !isChosen ? "opacity-50" : ""}`}
            >
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="font-medium">{t("agent.alternatives.option", { number: i + 1 })}</span>
                {infractions.map((inf) => {
                  const rule = ruleById.get(inf.ruleId)
                  return (
                    <Badge key={inf.ruleId} variant="destructive" className="px-1.5 py-0 text-[10px]">
                      {formatInfractionMessage(inf, rule ? translateRuleName(rule, t) : inf.ruleId, t)}
                    </Badge>
                  )
                })}
                <span className="ms-auto shrink-0">
                  {applied ? (
                    isChosen ? (
                      <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-700 dark:text-emerald-500">
                        <Check className="h-3 w-3" /> {t("agent.alternatives.chosen")}
                      </span>
                    ) : (
                      <span className="text-[10px] text-muted-foreground">{t("agent.alternatives.notUsed")}</span>
                    )
                  ) : (
                    <AppTooltip content={blockedReason ?? undefined} disabled={!blockedReason}>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-5 px-1.5 text-[10px]"
                        disabled={Boolean(blockedReason) || state === "applying"}
                        onClick={() => void choose(i)}
                        aria-label={t("agent.alternatives.useAriaLabel", { number: i + 1 })}
                      >
                        {state === "applying" && isChosen && <Spinner className="size-3" />}
                        {t("agent.alternatives.use")}
                      </Button>
                    </AppTooltip>
                  )}
                </span>
              </div>
              <div dir="auto" className="whitespace-pre-wrap break-words text-xs">
                {ev.display.after ?? (typeof ev.payload.value === "string" ? ev.payload.value : "")}
              </div>
            </li>
          )
        })}
      </ul>

      {error && (
        <InlineAiError message={error} label={t("autopilot.proposal.applyFailed")} className="text-[11px]" />
      )}

      {state === "applied" ? (
        <div className="text-[10px] text-muted-foreground">{t("agent.alternatives.othersDiscarded")}</div>
      ) : (
        <div className="flex items-center justify-end">
          <Button
            variant="ghost"
            className="h-6 text-[11px]"
            onClick={() => setState("discarded")}
            disabled={state === "applying"}
          >
            {t("agent.alternatives.discardAll")}
          </Button>
        </div>
      )}

      {blockedReason && <div className="text-end text-[10px] text-muted-foreground">{blockedReason}</div>}
    </div>
  )
}
