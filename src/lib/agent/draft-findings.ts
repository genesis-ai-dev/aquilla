/**
 * draft-findings — the QA findings the verifier pipeline stores on a staged
 * draft (auth-worker contextual/findings.ts + triage.ts), read back for the
 * PR-style review (docs/superpowers/specs/2026-09-30-agent-pr-threads-design.md).
 *
 * Stored shape (the draft's `verdicts` jsonb): `{ "<code>": "flag",
 * _triage: "human" | "advisory", _severity: "0".."4", _decidedBy }`. Codes and
 * categories only — there is no model prose to show, by design.
 *
 * AQU-1690: a Bible data finding is `bkp:<check>` ("bkp:V2"). Its value is
 * the finding's reason and pack evidence as encoded params (never prose),
 * which the chips format with the editor's Bible data check messages.
 */

import { decodeBibleParams } from "../../../db/shared/bible-checks/params"

export type FindingKind = "dissent" | "lint" | "bkp" | "unsupported" | "redrafted"

export interface DraftFinding {
  code: string
  kind: FindingKind
  /** The verifier (dissent), rule id (lint) or Bible data check (bkp, e.g. "V2"); null for the bare codes. */
  detail: string | null
  /** A `bkp:` finding's reason and evidence, when the server stored them. */
  params?: Record<string, string>
}

export interface DraftFindings {
  findings: DraftFinding[]
  triage: "human" | "advisory" | null
  severity: number
}

function parseCode(code: string, value: string | undefined): DraftFinding | null {
  if (code === "unsupported" || code === "redrafted") return { code, kind: code, detail: null }
  const [prefix, ...rest] = code.split(":")
  const detail = rest.join(":")
  if ((prefix === "dissent" || prefix === "lint") && detail) return { code, kind: prefix, detail }
  if (prefix === "bkp" && detail) {
    const params = decodeBibleParams(value)
    return { code, kind: "bkp", detail, ...(Object.keys(params).length > 0 ? { params } : {}) }
  }
  return null
}

export function findingsFromVerdicts(verdicts: Record<string, string> | null | undefined): DraftFindings {
  if (!verdicts) return { findings: [], triage: null, severity: 0 }
  const findings = Object.entries(verdicts)
    .filter(([k]) => !k.startsWith("_"))
    .map(([k, v]) => parseCode(k, v))
    .filter((f): f is DraftFinding => f !== null)
  const triage = verdicts._triage === "human" || verdicts._triage === "advisory" ? verdicts._triage : null
  const severity = Number.parseInt(verdicts._severity ?? "0", 10)
  return {
    findings,
    triage: findings.length > 0 ? triage : null,
    severity: Number.isFinite(severity) ? Math.max(0, Math.min(4, severity)) : 0,
  }
}

export function summarizeFindings(drafts: DraftFindings[]): { flagged: number; needsHuman: number; clean: number } {
  let flagged = 0
  let needsHuman = 0
  for (const d of drafts) {
    if (d.findings.length === 0) continue
    flagged += 1
    if (d.triage === "human") needsHuman += 1
  }
  return { flagged, needsHuman, clean: drafts.length - flagged }
}
