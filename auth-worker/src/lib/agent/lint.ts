// Deterministic draft lint for the agent's staged commits (design §4: "write
// feedback is a built-in linter"). Runs INSIDE emit staging so the MODEL sees
// rule violations in the verdict block and can fix its own drafts before a
// human ever reads the proposal — the client's proposal-card lint is for the
// user; this one is for the agent.
//
// Scope: the two project-rule types that judge draft text. Term-regex
// semantics are mirrored from src/lib/terminology/match.ts (inflectional `*`
// → \p{L}*, letter-class lookaround word boundaries, case-insensitive
// Unicode) — keep the two in lockstep. Builtin/algorithmic checks need the
// full lqa registry and stay client-side for now.

export interface LintRule {
  id: string
  name: string
  /** Human sentence describing what the rule requires. Terminology rules carry
   *  the approved/forbidden renderings here — which is the only place a model
   *  can learn them, so the contextual performer prompts from this, not `name`. */
  description?: string
  enabled: boolean
  check:
    | { type: "source-requires-target"; sourcePattern: string; targetPattern: string }
    | { type: "target-forbids"; targetPattern: string }
    | { type: string; [k: string]: unknown }
}

export interface LintHit {
  ruleId: string
  ruleName: string
  message: string
}

// ── Term regex (mirror of src/lib/terminology/match.ts) ─────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

const LEAD_BOUNDARY = "(?<!\\p{L})"
const TRAIL_BOUNDARY = "(?!\\p{L})"
const WILDCARD = "\\p{L}*"

export function termToRegexSource(term: string): string | null {
  const trimmed = term.trim()
  if (!trimmed) return null
  const hasLeadingStar = trimmed.startsWith("*")
  const hasTrailingStar = trimmed.endsWith("*")
  const body = trimmed.split("*").map(escapeRegex).join(WILDCARD)
  const lead = hasLeadingStar ? "" : LEAD_BOUNDARY
  const trail = hasTrailingStar ? "" : TRAIL_BOUNDARY
  return `${lead}${body}${trail}`
}

function buildTermRegex(term: string): RegExp | null {
  const src = termToRegexSource(term)
  if (src === null) return null
  try {
    return new RegExp(src, "iu")
  } catch {
    return null // malformed user pattern — never break staging over lint
  }
}

function matches(haystack: string, term: string): boolean {
  if (!haystack) return false
  const re = buildTermRegex(term)
  return re !== null && re.test(haystack)
}

// ── Rules loading ────────────────────────────────────────────────────────────

interface SettingsDb {
  prepare(query: string): {
    bind(...params: unknown[]): { first<T>(): Promise<T | null> }
  }
}

/** Load enabled project rules from project_settings (best-effort: lint must
 *  never block staging). */
export async function loadLintRules(db: SettingsDb, projectId: string): Promise<LintRule[]> {
  try {
    const row = await db
      .prepare(`SELECT settings::jsonb -> 'rules' AS rules FROM project_settings WHERE project_id = ?`)
      .bind(projectId)
      .first<{ rules: unknown }>()
    const raw = typeof row?.rules === "string" ? JSON.parse(row.rules) : row?.rules
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (r): r is LintRule =>
        !!r && typeof r === "object" && typeof (r as LintRule).id === "string" &&
        (r as LintRule).enabled === true && !!(r as LintRule).check,
    )
  } catch {
    return []
  }
}

/** Lint one staged draft: after-text against the project's enabled rules. */
export function lintDraft(rules: LintRule[], sourceText: string, afterText: string): LintHit[] {
  if (!afterText) return []
  const hits: LintHit[] = []
  for (const rule of rules) {
    const c = rule.check
    if (c.type === "target-forbids" && typeof c.targetPattern === "string") {
      if (matches(afterText, c.targetPattern)) {
        hits.push({
          ruleId: rule.id,
          ruleName: rule.name,
          message: `forbidden in target: "${c.targetPattern}"`,
        })
      }
    } else if (
      c.type === "source-requires-target" &&
      typeof c.sourcePattern === "string" &&
      typeof c.targetPattern === "string"
    ) {
      if (matches(sourceText, c.sourcePattern) && !matches(afterText, c.targetPattern)) {
        hits.push({
          ruleId: rule.id,
          ruleName: rule.name,
          message: `source contains "${c.sourcePattern}" but target is missing "${c.targetPattern}"`,
        })
      }
    }
    // Other rule types (source-target-match, builtin) stay client-side.
  }
  return hits
}
