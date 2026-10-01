/**
 * DraftFindingChips — a draft's verifier findings as quiet chips, plus its
 * triage badge (PR threads spec §4). Shared by Files changed and Checks, so a
 * finding reads the same wherever it appears. Monochrome except "Needs you".
 */

import { Badge } from "@/components/ui/badge"
import { useT } from "@/lib/i18n/I18nProvider"
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
    case "unsupported":
      return t("agent.finding.unsupported")
    case "redrafted":
      return t("agent.finding.redrafted")
  }
}

export function DraftFindingChips({ review }: { review: DraftFindings | undefined }) {
  const t = useT()
  if (!review || review.findings.length === 0) return null
  return (
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
}
