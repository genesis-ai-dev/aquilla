/**
 * style-rule-extractor.ts — per-KB-node structured extraction of style-rule
 * candidates (AQU-934 phase 2, client-driven v1).
 *
 * Input is a knowledge doc's section tree (~2000-char nodes with stable ids);
 * each node's text is fetched through the knowledge client and fed to ONE
 * strict-JSON completion (usage kind "style-rule-extract"). Output candidates
 * are hard-validated against the category and scopeHint whitelists — invalid
 * entries are dropped, invalid checkSpecs are stripped (instruction-only
 * rules are first-class). The caller posts survivors as `proposed` rules with
 * `source: { kind: "knowledge-doc", docId, nodeId, quote }` and initial
 * likely_applies applicability rows derived from scopeHint.
 *
 * Fence-stripping/parse robustness mirrors rule-extractor.ts.
 */

import { complete } from "@/lib/completion/completion-service"
import {
  getKnowledgeDocumentContent,
  type KnowledgeNode,
  type KnowledgeScope,
} from "@/lib/frontier/knowledge-base"
import type { FrontierSession } from "@/lib/frontier/types"
import type { CompletionSettings, RuleCheck } from "@/lib/parsers/types"
import type { UsageCallback } from "./rule-suggester"
import type { StyleRuleCandidate, StyleRuleCategory, StyleRuleExample } from "./style-rule-types"

const CATEGORIES: readonly StyleRuleCategory[] = [
  "terminology",
  "register",
  "formatting",
  "grammar",
  "orthography",
  "style",
  "other",
]

/** scopeHint target types a candidate may carry ("global" aside). */
const SCOPE_HINT_TARGET_TYPES = ["genre", "book", "file"] as const

const MAX_QUOTE_CHARS = 240

// ── Prompt ──────────────────────────────────────────────────────────────────

const EXTRACT_SYSTEM_PROMPT = `You are an expert translation-quality analyst reading ONE section of a project's style guide or translation guidelines.

Extract every concrete rule, convention, or constraint a translator (or an AI drafting assistant) should follow. Output a JSON array of rule objects with this exact shape:

{
  "instruction": "Imperative, self-contained rule text",
  "category": "terminology" | "register" | "formatting" | "grammar" | "orthography" | "style" | "other",
  "scopeHint": "global" | "genre:<genre>" | "book:<CODE>",
  "conditions": "optional free-text conditions, e.g. \\"only in direct speech\\"",
  "examples": [{ "before": "…", "after": "…", "note": "…" }],
  "exceptions": "optional free-text exceptions",
  "checkSpec": { … }
}

scopeHint: use "global" unless the section explicitly limits the rule to a genre (e.g. "genre:poetry") or one book (e.g. "book:PSA" — the 3-letter USFM code).

checkSpec is OPTIONAL. Include it ONLY when the rule is trivially enforceable with a regex, as ONE of:
1. { "type": "source-target-match", "pattern": "regex" } — the pattern must appear in BOTH source and target.
2. { "type": "source-requires-target", "sourcePattern": "regex", "targetPattern": "regex" } — if source matches, target must too.
3. { "type": "target-forbids", "targetPattern": "regex" } — target must NOT match.
Use JavaScript regex syntax and escape backslashes for JSON (\\\\d for \\d). Omit checkSpec whenever a regex cannot fully capture the rule — instruction-only rules are expected and useful.

Rules:
- Each instruction must stand alone without the surrounding document.
- Only state rules the section actually contains; do not invent.
- Skip vague aspirations that give a translator nothing actionable.
- Output ONLY a valid JSON array (possibly empty: []). No markdown, no code fences, no commentary.`

// ── Parsing + validation ────────────────────────────────────────────────────

function isValidScopeHint(value: string): boolean {
  if (value === "global") return true
  const sep = value.indexOf(":")
  if (sep <= 0) return false
  const targetType = value.slice(0, sep)
  const targetId = value.slice(sep + 1).trim()
  return (
    (SCOPE_HINT_TARGET_TYPES as readonly string[]).includes(targetType) && targetId.length > 0
  )
}

/** Normalize a raw scopeHint (case/whitespace) or return null when invalid. */
function normalizeScopeHint(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (trimmed.toLowerCase() === "global") return "global"
  const sep = trimmed.indexOf(":")
  if (sep <= 0) return null
  const targetType = trimmed.slice(0, sep).trim().toLowerCase()
  let targetId = trimmed.slice(sep + 1).trim()
  if (targetType === "book") targetId = targetId.toUpperCase()
  const normalized = `${targetType}:${targetId}`
  return isValidScopeHint(normalized) ? normalized : null
}

function compilable(pattern: unknown): pattern is string {
  if (typeof pattern !== "string" || !pattern) return false
  try {
    new RegExp(pattern)
    return true
  } catch {
    return false
  }
}

/** Validate a candidate checkSpec: known shape AND compiling patterns. */
export function validateCheckSpec(value: unknown): RuleCheck | null {
  if (!value || typeof value !== "object") return null
  const check = value as Record<string, unknown>
  if (check.type === "source-target-match" && compilable(check.pattern)) {
    return { type: "source-target-match", pattern: check.pattern }
  }
  if (check.type === "target-forbids" && compilable(check.targetPattern)) {
    return { type: "target-forbids", targetPattern: check.targetPattern }
  }
  if (
    check.type === "source-requires-target" &&
    compilable(check.sourcePattern) &&
    compilable(check.targetPattern)
  ) {
    return {
      type: "source-requires-target",
      sourcePattern: check.sourcePattern,
      targetPattern: check.targetPattern,
    }
  }
  return null
}

function sanitizeExamples(value: unknown): StyleRuleExample[] | undefined {
  if (!Array.isArray(value)) return undefined
  const examples: StyleRuleExample[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue
    const raw = entry as Record<string, unknown>
    const example: StyleRuleExample = {}
    if (typeof raw.before === "string" && raw.before.trim()) example.before = raw.before
    if (typeof raw.after === "string" && raw.after.trim()) example.after = raw.after
    if (typeof raw.note === "string" && raw.note.trim()) example.note = raw.note
    if (example.before !== undefined || example.after !== undefined || example.note !== undefined) {
      examples.push(example)
    }
  }
  return examples.length > 0 ? examples : undefined
}

/** Hard-validate one raw entry; null = drop it (bad category/scopeHint/shape).
 * An invalid checkSpec is stripped, keeping the instruction-only candidate. */
function sanitizeCandidate(value: unknown): StyleRuleCandidate | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  if (typeof raw.instruction !== "string" || !raw.instruction.trim()) return null
  if (typeof raw.category !== "string" || !(CATEGORIES as readonly string[]).includes(raw.category)) {
    return null
  }
  const scopeHint = normalizeScopeHint(raw.scopeHint)
  if (!scopeHint) return null

  const candidate: StyleRuleCandidate = {
    instruction: raw.instruction.trim(),
    category: raw.category as StyleRuleCategory,
    scopeHint,
  }
  if (typeof raw.conditions === "string" && raw.conditions.trim()) {
    candidate.conditions = raw.conditions.trim()
  }
  if (typeof raw.exceptions === "string" && raw.exceptions.trim()) {
    candidate.exceptions = raw.exceptions.trim()
  }
  const examples = sanitizeExamples(raw.examples)
  if (examples) candidate.examples = examples
  const checkSpec = validateCheckSpec(raw.checkSpec)
  if (checkSpec) candidate.checkSpec = checkSpec
  return candidate
}

/**
 * Parse a raw completion into validated candidates. Robust to code fences and
 * prose wrappers (everything outside the outermost [] is ignored); invalid
 * JSON or a non-array yields [].
 */
export function parseStyleRuleCandidates(raw: string): StyleRuleCandidate[] {
  let cleaned = raw.trim()
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")
  const start = cleaned.indexOf("[")
  const end = cleaned.lastIndexOf("]")
  if (start === -1 || end === -1 || end < start) return []
  try {
    const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1))
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(sanitizeCandidate)
      .filter((c): c is StyleRuleCandidate => c !== null)
  } catch {
    return []
  }
}

// ── Extraction run ──────────────────────────────────────────────────────────

/** A validated candidate plus its citation back to the section it came from. */
export interface ExtractedStyleRuleCandidate {
  candidate: StyleRuleCandidate
  nodeId: string
  nodeTitle: string
  /** Leading excerpt of the section text — feeds `source.quote`. */
  quote: string
}

export interface StyleRuleExtractionInput {
  scope: KnowledgeScope
  docId: string
  /** Section nodes to process, e.g. `flattenLeafNodes(tree)`. */
  nodes: KnowledgeNode[]
  jwt: string
  settings: CompletionSettings
  session?: FrontierSession | null
  /** Aborting stops between nodes (and in-flight completions) and returns the
   * candidates found so far. */
  signal?: AbortSignal
  /** Called with (0, total, 0) up front, then after every node. */
  onProgress?: (nodeIndex: number, total: number, found: number) => void
  onLlmCall?: UsageCallback
}

/**
 * Leaf sections of a knowledge tree in document order — the ~2000-char text
 * nodes extraction runs over (parents span their children's text, so running
 * parents too would double-cover it).
 */
export function flattenLeafNodes(tree: KnowledgeNode[]): KnowledgeNode[] {
  const leaves: KnowledgeNode[] = []
  const visit = (node: KnowledgeNode) => {
    if (node.children && node.children.length > 0) {
      node.children.forEach(visit)
    } else {
      leaves.push(node)
    }
  }
  tree.forEach(visit)
  return leaves
}

function excerpt(text: string): string {
  const collapsed = text.trim().replace(/\s+/g, " ")
  if (collapsed.length <= MAX_QUOTE_CHARS) return collapsed
  const slice = collapsed.slice(0, MAX_QUOTE_CHARS)
  const lastSpace = slice.lastIndexOf(" ")
  return `${(lastSpace > MAX_QUOTE_CHARS / 2 ? slice.slice(0, lastSpace) : slice).trimEnd()}…`
}

/**
 * Run extraction sequentially over the given nodes. Completion/network errors
 * propagate (fail fast); an abort returns the partial result instead.
 */
export async function extractStyleRulesFromDoc(
  input: StyleRuleExtractionInput,
): Promise<ExtractedStyleRuleCandidate[]> {
  const { nodes, onProgress, signal } = input
  const results: ExtractedStyleRuleCandidate[] = []
  onProgress?.(0, nodes.length, 0)

  for (let i = 0; i < nodes.length; i++) {
    if (signal?.aborted) break
    const node = nodes[i]
    let text: string
    let raw: string
    try {
      text = await getKnowledgeDocumentContent(input.scope, input.jwt, input.docId, node.id)
      if (!text.trim()) {
        onProgress?.(i + 1, nodes.length, results.length)
        continue
      }
      raw = await complete({
        settings: {
          ...input.settings,
          maxTokens: Math.min(input.settings.maxTokens, 2048),
          temperature: 0.1,
        },
        session: input.session ?? null,
        messages: [
          { role: "system", content: EXTRACT_SYSTEM_PROMPT },
          {
            role: "user",
            content: `Extract style rules from this section ("${node.title}"):\n\n${text}`,
          },
        ],
        signal,
      })
      input.onLlmCall?.({
        kind: "style-rule-extract",
        model: input.settings.model,
        provider: input.settings.provider || "frontier",
      })
    } catch (err) {
      if (signal?.aborted) break
      throw err
    }

    const quote = excerpt(text)
    for (const candidate of parseStyleRuleCandidates(raw)) {
      results.push({ candidate, nodeId: node.id, nodeTitle: node.title, quote })
    }
    onProgress?.(i + 1, nodes.length, results.length)
  }

  return results
}
