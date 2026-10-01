/**
 * draft-findings — the QA findings the verifier pipeline stores on a staged
 * draft (auth-worker contextual/findings.ts + triage.ts), read back for the
 * PR-style review (docs/superpowers/specs/2026-09-30-agent-pr-threads-design.md).
 *
 * Stored shape (the draft's `verdicts` jsonb): `{ "<code>": "flag",
 * _triage: "human" | "advisory", _severity: "0".."4", _decidedBy }`. Codes and
 * categories only — there is no model prose to show, by design.
 */

export type FindingKind = "dissent" | "lint" | "unsupported" | "redrafted"

export interface DraftFinding {
  code: string
  kind: FindingKind
  /** The verifier (dissent) or rule id (lint); null for the bare codes. */
  detail: string | null
}

export interface DraftFindings {
  findings: DraftFinding[]
  triage: "human" | "advisory" | null
  severity: number
}

function parseCode(code: string): DraftFinding | null {
  if (code === "unsupported" || code === "redrafted") return { code, kind: code, detail: null }
  const [prefix, ...rest] = code.split(":")
  const detail = rest.join(":")
  if ((prefix === "dissent" || prefix === "lint") && detail) return { code, kind: prefix, detail }
  return null
}

export function findingsFromVerdicts(verdicts: Record<string, string> | null | undefined): DraftFindings {
  if (!verdicts) return { findings: [], triage: null, severity: 0 }
  const findings = Object.keys(verdicts)
    .filter((k) => !k.startsWith("_"))
    .map(parseCode)
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
