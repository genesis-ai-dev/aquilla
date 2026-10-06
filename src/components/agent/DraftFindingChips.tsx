/**
 * DraftFindingChips — a draft's verifier findings as quiet chips, plus its
 * triage badge (PR threads spec §4). Shared by Files changed and Checks, so a
 * finding reads the same wherever it appears. Monochrome except "Needs you".
 *
 * AQU-1690: a Bible data finding (`bkp:`) names its check, and with
 * `evidence` the chips are followed by what it means and where the fact comes
 * from — the editor's own Bible data check messages.
 */

import { Badge } from "@/components/ui/badge"
import { useT } from "@/lib/i18n/I18nProvider"
import { useFormat } from "@/lib/i18n/format"
import { bibleFindingEvidence, bibleFindingLabel } from "@/lib/agent/bible-findings"
import type { DraftFinding, DraftFindings } from "@/lib/agent/draft-findings"

type T = ReturnType<typeof useT>

export function findingLabel(finding: DraftFinding, t: T): string {
  switch (finding.kind) {
    case "dissent":
      return finding.detail === "force"
        ? t("agent.finding.dissent.force")
        : finding.detail === "naturalness"
          ? t("agent.finding.dissent.naturalness")
          : t("agent.finding.dissent.other")
    case "lint":
      return t("agent.finding.lint", { rule: finding.detail ?? "" })
    case "bkp":
      return bibleFindingLabel(finding, t)
    case "unsupported":
      return t("agent.finding.unsupported")
    case "redrafted":
      return t("agent.finding.redrafted")
  }
}

function BibleEvidence({ findings }: { findings: DraftFinding[] }) {
  const t = useT()
  const format = useFormat()
  const lines = findings.flatMap((finding) => bibleFindingEvidence(finding, t, format))
  if (lines.length === 0) return null
  return (
    <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground" data-testid="draft-finding-evidence">
      {lines.map((line, i) => (
        <li key={`${i}:${line}`}>{line}</li>
      ))}
    </ul>
  )
}

export function DraftFindingChips({ review, evidence = false }: { review: DraftFindings | undefined; evidence?: boolean }) {
  const t = useT()
  if (!review || review.findings.length === 0) return null
  const chips = (
    <span className="flex flex-wrap items-center gap-1" data-testid="draft-finding-chips">
      {review.triage && (
        <Badge variant={review.triage === "human" ? "destructive" : "outline"}>
          {t(review.triage === "human" ? "agent.finding.needsYou" : "agent.finding.advisory")}
        </Badge>
      )}
      {review.findings.map((finding) => (
        <Badge key={finding.code} variant="secondary">{findingLabel(finding, t)}</Badge>
      ))}
    </span>
  )
  if (!evidence) return chips
  return (
    <span className="flex flex-col gap-1">
      {chips}
      <BibleEvidence findings={review.findings} />
    </span>
  )
}
