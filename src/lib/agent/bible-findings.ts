/**
 * bible-findings — a draft's `bkp:` findings as words (AQU-1690).
 *
 * Autopilot stores a Bible data finding as `bkp:<check>` with its reason and
 * pack evidence as params (src/lib/agent/draft-findings.ts). The label names
 * the check the way Rules → Built-in checks does; the explanation and the
 * evidence line reuse the editor's own Bible data check messages
 * (src/lib/bible-data/check-messages.ts), so one finding reads the same in
 * the editor and in autopilot's review.
 */

import { formatBibleCheckEvidence, formatBibleCheckReason } from "@/lib/bible-data/check-messages"
import type { TFunction } from "@/lib/i18n/I18nProvider"
import type { LocaleFormatters } from "@/lib/i18n/format"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { RuleInfraction } from "@/lib/parsers/types"
import { isBibleCheckId } from "../../../db/shared/bible-checks/types"
import type { DraftFinding } from "./draft-findings"

/** Check names: the editor's built-in check names, and the three that only autopilot's Jev questions ask. */
const CHECK_NAME: Readonly<Record<string, MessageKey>> = {
  V1: "bibleData.check.v1.name",
  V2: "bibleData.check.v2.name",
  V3: "bibleData.check.v3.name",
  V5: "bibleData.check.v5.name",
  V7: "bibleData.check.v7.name",
  V8: "bibleData.check.v8.name",
  V9: "bibleData.check.v9.name",
  M1: "bibleData.check.m1.name",
  V13: "agent.finding.bibleCheck.speaker",
  M3: "agent.finding.bibleCheck.negation",
  P8: "agent.finding.bibleCheck.youNumber",
}

export function bibleFindingLabel(finding: DraftFinding, t: TFunction): string {
  const detail = finding.detail ?? ""
  const key = Object.hasOwn(CHECK_NAME, detail) ? CHECK_NAME[detail] : undefined
  return key ? t("agent.finding.bible", { check: t(key) }) : t("agent.finding.bibleUnknown", { code: detail })
}

/**
 * What the finding means and where its fact comes from, e.g. "The quotation
 * closes after the narration that follows it…" and "OpenText speech JHN 4:9
 * words 8–18; speaker from Clear speaker-quotations (confidence 97%)". Empty
 * when the draft stored no params (a Jev-confirmed finding) or the check is
 * unknown to this version.
 */
export function bibleFindingEvidence(
  finding: DraftFinding,
  t: TFunction,
  format: Pick<LocaleFormatters, "list" | "percent">,
): string[] {
  if (finding.kind !== "bkp" || !finding.params) return []
  const code = `bkp:${finding.detail ?? ""}`
  if (!isBibleCheckId(code)) return []
  const infraction: RuleInfraction = {
    ruleId: code,
    cellId: "",
    fileId: "",
    reason: `builtin:${code}`,
    reasonParams: finding.params,
    spans: [],
  }
  return [formatBibleCheckReason(infraction, t), ...formatBibleCheckEvidence(infraction, t, format)]
}
