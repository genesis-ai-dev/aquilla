/**
 * AQU-1705: the verdict table the editor and the agent must agree on.
 *
 * A project rule has two readers. The editor's rule engine
 * (src/lib/rules/rule-engine.ts) decides what the PERSON sees marked on a
 * cell. The agent's draft lint (auth-worker/src/lib/agent/lint.ts) decides
 * what the MODEL is told about its own drafts: emit-stage's NEEDS REVIEW
 * lines, autopilot's lint_rules node, and the read tool's filter:'flagged'.
 * When the two disagree, the agent rewrites lines the person sees as fine and
 * leaves lines the person sees as broken.
 *
 * Both suites run every row: rule-engine.test.ts through checkRulesForCell,
 * auth-worker's agent-lint.test.ts through lintDraft. `flagged` is the
 * editor's verdict, so a semantics change on either side fails that side.
 *
 * Plain data on purpose: auth-worker's tsc and Vitest import this file by
 * relative path and cannot resolve the SPA's `@/` aliases.
 */

export type ParityRuleCheck =
  | { type: "target-forbids"; targetPattern: string; caseSensitive?: boolean }
  | { type: "source-requires-target"; sourcePattern: string; targetPattern: string; caseSensitive?: boolean }

export interface RuleLintParityCase {
  /** What the row proves. */
  name: string
  /** Only `term:` ids compile with the `u` flag. */
  ruleId: string
  check: ParityRuleCheck
  source: string
  target: string
  /** The editor marks this cell, so the agent must be told too. */
  flagged: boolean
}

const GRACE: ParityRuleCheck = { type: "source-requires-target", sourcePattern: "grace", targetPattern: "gracia" }

export const RULE_LINT_PARITY_CASES: RuleLintParityCase[] = [
  // Patterns are regexes. The rule editor stores regex by default, and its
  // literal mode stores the text already escaped.
  {
    name: "regex syntax: `colou?r` forbids 'color' too",
    ruleId: "user-regex",
    check: { type: "target-forbids", targetPattern: "colou?r" },
    source: "the colour red",
    target: "the color red",
    flagged: true,
  },
  {
    name: "alternation: `sin|pecado` forbids either word",
    ruleId: "user-alternation",
    check: { type: "target-forbids", targetPattern: "sin|pecado" },
    source: "sin",
    target: "el pecado",
    flagged: true,
  },
  {
    name: "literal mode: 'Mr.' is stored as `Mr\\.` and matches 'Mr.'",
    ruleId: "user-literal",
    check: { type: "target-forbids", targetPattern: "Mr\\." },
    source: "Mr. Smith arrived",
    target: "Mr. Smith llegó",
    flagged: true,
  },

  // No word boundaries are added.
  {
    name: "substring: `graci` matches inside 'gracias'",
    ruleId: "user-substring",
    check: { type: "target-forbids", targetPattern: "graci" },
    source: "thanks",
    target: "muchas gracias",
    flagged: true,
  },
  {
    name: "substring in the source: `grace` inside 'disgraceful' makes the rule apply",
    ruleId: "user-grace",
    check: GRACE,
    source: "a disgraceful act",
    target: "un acto vergonzoso",
    flagged: true,
  },

  // Case: insensitive unless the rule says caseSensitive.
  {
    name: "case-insensitive by default: `god` matches 'God'",
    ruleId: "user-case-default",
    check: { type: "target-forbids", targetPattern: "god" },
    source: "God is good",
    target: "God es bueno",
    flagged: true,
  },
  {
    name: "caseSensitive: `God` does not match 'god'",
    ruleId: "user-case-sensitive",
    check: { type: "target-forbids", targetPattern: "God", caseSensitive: true },
    source: "a god of wood",
    target: "un god de madera",
    flagged: false,
  },
  {
    name: "caseSensitive: `God` still matches 'God'",
    ruleId: "user-case-sensitive",
    check: { type: "target-forbids", targetPattern: "God", caseSensitive: true },
    source: "God is good",
    target: "God es bueno",
    flagged: true,
  },

  // source-requires-target compares how many times each side matches.
  {
    name: "counts: 'grace upon grace' needs two renderings",
    ruleId: "user-grace",
    check: GRACE,
    source: "grace upon grace",
    target: "gracia sobre favor",
    flagged: true,
  },
  {
    name: "counts: an extra rendering is flagged too",
    ruleId: "user-grace",
    check: GRACE,
    source: "by grace",
    target: "por gracia y gracia",
    flagged: true,
  },
  {
    name: "counts: equal counts pass",
    ruleId: "user-grace",
    check: GRACE,
    source: "grace upon grace",
    target: "gracia sobre gracia",
    flagged: false,
  },
  {
    name: "the rule does not apply when the source lacks the pattern",
    ruleId: "user-grace",
    check: GRACE,
    source: "by faith",
    target: "por fe",
    flagged: false,
  },

  // Flags: `u` for term: rules only.
  {
    name: "term: rules compile with `u`, so their compiled \\p{L} wildcard matches",
    ruleId: "term:c1:forbidden:baptiz\\*",
    check: { type: "target-forbids", targetPattern: "(?<!\\p{L})baptiz\\p{L}*" },
    source: "he baptized them",
    target: "los baptizó",
    flagged: true,
  },
  {
    name: "user rules compile without `u`, so `e\\-mail` stays a valid pattern",
    ruleId: "user-identity-escape",
    check: { type: "target-forbids", targetPattern: "e\\-mail" },
    source: "send an email",
    target: "send an e-mail",
    flagged: true,
  },

  // Never flagged.
  {
    name: "an invalid pattern never flags",
    ruleId: "user-invalid",
    check: { type: "target-forbids", targetPattern: "([" },
    source: "anything",
    target: "anything",
    flagged: false,
  },
  {
    name: "a whitespace-only translation is not checked",
    ruleId: "user-grace",
    check: GRACE,
    source: "grace",
    target: "   ",
    flagged: false,
  },
]
