// Deterministic draft lint for the agent's staged commits (design §4: "write
// feedback is a built-in linter"). Runs INSIDE emit staging so the MODEL sees
// rule violations in the verdict block and can fix its own drafts before a
// human ever reads the proposal — the client's proposal-card lint is for the
// user; this one is for the agent.
//
// Scope: the two project-rule types that judge draft text, evaluated exactly
// as the editor's checkRule (src/lib/rules/rule-engine.ts) evaluates them, so
// the agent is told about the violations the person sees and no others
// (AQU-1705). Both test suites run the shared verdict table in
// src/lib/rules/__fixtures__/rule-lint-parity.ts. Builtin/algorithmic checks
// need the full lqa registry and stay client-side for now.

export interface LintRule {
  id: string
  name: string
  /** Human sentence describing what the rule requires. Terminology rules carry
   *  the approved/forbidden renderings here — which is the only place a model
   *  can learn them, so the contextual performer prompts from this, not `name`. */
  description?: string
  /** AQU-609: `"lane"`-scoped rules apply only to their `lane`; any other
   *  scope (or none, for legacy rows) applies in every lane. Passed through
   *  verbatim from the SPA's `TranslationRule` in project settings JSON. */
  scope?: string
  /** Target-language lane a `scope === "lane"` rule is pinned to; `''` = the
   *  project-default lane. */
  lane?: string
  enabled: boolean
  check:
    | { type: "source-requires-target"; sourcePattern: string; targetPattern: string; caseSensitive?: boolean }
    | { type: "target-forbids"; targetPattern: string; caseSensitive?: boolean }
    | { type: string; [k: string]: unknown }
}

/**
 * AQU-609: restrict a rules array to the given target-language lane (`''` =
 * the project-default lane). Mirror of `rulesForLane` in the SPA's
 * `src/lib/rules/rule-engine.ts` — keep the predicates identical.
 */
export function rulesForLane(rules: LintRule[], lane: string): LintRule[] {
  return rules.filter((r) => r.scope !== "lane" || (r.lane ?? "") === lane)
}

export interface LintHit {
  ruleId: string
  ruleName: string
  message: string
}

// ── Rule patterns (mirror of checkRule in src/lib/rules/rule-engine.ts) ─────

/**
 * Compile a rule pattern the way the editor does. Patterns are raw regexes:
 * the rule editor stores regex by default and escapes literal-mode text
 * itself, and `term:` rules carry the term matcher's output
 * (src/lib/terminology/compile-core.ts). Flags match the editor: `i` unless
 * the rule is caseSensitive, and `u` only for `term:` rules, whose \p{L}
 * classes need it — adding `u` to a user regex can make a valid pattern
 * invalid.
 */
export function compileRulePattern(rule: LintRule, pattern: string): RegExp | null {
  const caseFlag = rule.check.caseSensitive === true ? "" : "i"
  const unicodeFlag = rule.id.startsWith("term:") ? "u" : ""
  // ReDoS guard: this runs in the worker request path. Skip oversized patterns
  // and the classic nested-quantifier shape `(a+)+` / `(a*)*` / `(a|b+){2,}`.
  if (!unicodeFlag && (pattern.length > 1000 || /\([^()]*[+*][^()]*\)\s*(?:[+*]|\{\d+,\d*\})/.test(pattern))) {
    return null
  }
  try {
    return new RegExp(pattern, `g${caseFlag}${unicodeFlag}`)
  } catch {
    return null // malformed user pattern — never break staging over lint
  }
}

/** Instances, counted as the editor counts them: non-empty matches. `re` must
 *  carry the `g` flag; matchAll works on a copy, so `re` can be reused. */
export function countMatches(text: string, re: RegExp): number {
  let n = 0
  for (const m of text.matchAll(re)) if (m[0].length > 0) n++
  return n
}

/** Why a rule fails a draft. Counts are the editor's: non-empty matches. */
export type RuleViolation =
  | { type: "target-forbids" }
  | { type: "source-requires-target"; sourceCount: number; targetCount: number }

/**
 * Judge one draft against one rule, as the editor's checkRule does. Both
 * lints decide with this: lintDraft for project rules, and lintTerminology
 * (contextual/project-context.ts) for the `term:` rules it compiles
 * (AQU-1711). Null when the rule passes or does not apply.
 */
export function ruleViolation(rule: LintRule, sourceText: string, afterText: string): RuleViolation | null {
  const c = rule.check
  if (c.type === "target-forbids" && typeof c.targetPattern === "string") {
    return compileRulePattern(rule, c.targetPattern)?.test(afterText) ? { type: "target-forbids" } : null
  }
  if (
    c.type === "source-requires-target" &&
    typeof c.sourcePattern === "string" &&
    typeof c.targetPattern === "string"
  ) {
    const sourceRe = compileRulePattern(rule, c.sourcePattern)
    const targetRe = compileRulePattern(rule, c.targetPattern)
    const sourceCount = sourceRe ? countMatches(sourceText, sourceRe) : 0
    if (!targetRe || sourceCount === 0) return null
    // Like the editor: one rendering per source instance, so too few and
    // too many are both violations.
    const targetCount = countMatches(afterText, targetRe)
    return targetCount === sourceCount ? null : { type: "source-requires-target", sourceCount, targetCount }
  }
  // Other rule types (source-target-match, builtin) stay client-side.
  return null
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
  // Like the editor, rules do not judge an empty translation.
  if (!afterText.trim()) return []
  const hits: LintHit[] = []
  for (const rule of rules) {
    const violation = ruleViolation(rule, sourceText, afterText)
    if (!violation) continue
    // ruleViolation judged these patterns, so both are strings here.
    const { sourcePattern, targetPattern } = rule.check as { sourcePattern?: string; targetPattern?: string }
    hits.push({
      ruleId: rule.id,
      ruleName: rule.name,
      message:
        violation.type === "target-forbids"
          ? `forbidden in target: "${targetPattern}"`
          : violation.targetCount === 0
            ? `source contains "${sourcePattern}" but target is missing "${targetPattern}"`
            : `counts don't add up: "${sourcePattern}" ×${violation.sourceCount} in the source, "${targetPattern}" ×${violation.targetCount} in the target`,
    })
  }
  return hits
}
