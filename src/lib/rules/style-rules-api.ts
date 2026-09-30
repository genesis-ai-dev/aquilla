/**
 * style-rules-api.ts — typed fetch client for the style-rule library +
 * applicability routes (AQU-934 phase 2; auth-worker, mounted under
 * /api/v2/projects/:projectId/style-rules). Mirrors
 * src/lib/agent/memory-api.ts conventions: AUTH_BASE + fetchWithTimeout +
 * `Authorization: Bearer <jwt>`, `{ error: { code, message } }` envelope
 * parsed into thrown Error subclasses on non-OK responses.
 *
 * Role floors are server-enforced (GET member+, POST CONTRIBUTOR+, PATCH /
 * review / applicability writes PROJECT_LEAD+; org-scoped rows are read-only
 * through these project routes) — this client just forwards.
 */

import { AUTH_BASE } from "@/lib/frontier/auth"
import { fetchWithTimeout } from "@/lib/frontier/orgs"
import type {
  CreateStyleRuleInput,
  RuleApplicability,
  StyleRule,
  StyleRuleStatus,
  UpdateStyleRuleInput,
  UpsertApplicabilityInput,
} from "./style-rule-types"

export type StyleRuleReviewAction = "approve" | "reject"

/** GET list payload: project rows + inherited org rows, with the
 * applicability rows covering exactly the returned rules. */
export interface StyleRulesListResult {
  rules: StyleRule[]
  applicability: RuleApplicability[]
}

/** POST payload: the created rule plus its atomically-created initial rows. */
export interface CreatedStyleRule {
  rule: StyleRule
  applicability: RuleApplicability[]
}

// ── Typed errors ────────────────────────────────────────────────────────────

/** Generic non-OK response; `code` carries the server envelope code when present. */
export class StyleRulesApiError extends Error {
  public status: number
  public code: string | undefined
  constructor(message: string, status: number, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** 403 `permission_denied` — below the role floor, or a write against an
 * org-scoped rule through the project routes (org rows are read-only here). */
export class StyleRulePermissionError extends StyleRulesApiError {
  constructor(message = "You don't have permission to change this style rule.") {
    super(message, 403, "permission_denied")
  }
}

/** 404 `not_found` — the rule or applicability row is gone (e.g. deleted or
 * reviewed away by someone else). Callers should refresh their list. */
export class StyleRuleNotFoundError extends StyleRulesApiError {
  constructor(message = "This style rule no longer exists.") {
    super(message, 404, "not_found")
  }
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string }
}

async function parseErrorAndThrow(res: Response, fallback: string): Promise<never> {
  let body: ErrorEnvelope | null = null
  try {
    body = (await res.json()) as ErrorEnvelope
  } catch {
    // non-JSON error body — fall through to the generic error
  }
  const code = body?.error?.code
  const message = body?.error?.message ?? fallback

  if (res.status === 403 && code === "permission_denied") {
    throw new StyleRulePermissionError(message)
  }
  if (res.status === 404 && code === "not_found") {
    throw new StyleRuleNotFoundError(message)
  }
  throw new StyleRulesApiError(`${fallback}: HTTP ${res.status} — ${message}`, res.status, code)
}

function authHeaders(jwt: string): HeadersInit {
  return { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" }
}

function rulesBase(projectId: string): string {
  return `${AUTH_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/style-rules`
}

// ── Routes ──────────────────────────────────────────────────────────────────

/** GET …/style-rules[?status=] (any project member). Omit `status` for all rows. */
export async function listStyleRules(
  jwt: string,
  projectId: string,
  status?: StyleRuleStatus,
): Promise<StyleRulesListResult> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : ""
  const res = await fetchWithTimeout(`${rulesBase(projectId)}${qs}`, {
    headers: authHeaders(jwt),
  })
  if (!res.ok) return parseErrorAndThrow(res, "list style rules failed")
  return (await res.json()) as StyleRulesListResult
}

/** POST …/style-rules (CONTRIBUTOR+). Status is forced `proposed`; initial
 * applicability rows are created atomically with the rule. */
export async function createStyleRule(
  jwt: string,
  projectId: string,
  input: CreateStyleRuleInput,
): Promise<CreatedStyleRule> {
  const res = await fetchWithTimeout(rulesBase(projectId), {
    method: "POST",
    headers: authHeaders(jwt),
    body: JSON.stringify(input),
  })
  if (!res.ok) return parseErrorAndThrow(res, "create style rule failed")
  return (await res.json()) as CreatedStyleRule
}

/** PATCH …/style-rules/:ruleId (PROJECT_LEAD+). Sets `humanEdited: true`,
 * bumps `version`. */
export async function updateStyleRule(
  jwt: string,
  projectId: string,
  ruleId: string,
  patch: UpdateStyleRuleInput,
): Promise<StyleRule> {
  const res = await fetchWithTimeout(`${rulesBase(projectId)}/${encodeURIComponent(ruleId)}`, {
    method: "PATCH",
    headers: authHeaders(jwt),
    body: JSON.stringify(patch),
  })
  if (!res.ok) return parseErrorAndThrow(res, "update style rule failed")
  return ((await res.json()) as { rule: StyleRule }).rule
}

/** POST …/style-rules/:ruleId/review (PROJECT_LEAD+). Sets `reviewedBy`. */
export async function reviewStyleRule(
  jwt: string,
  projectId: string,
  ruleId: string,
  action: StyleRuleReviewAction,
): Promise<StyleRule> {
  const res = await fetchWithTimeout(
    `${rulesBase(projectId)}/${encodeURIComponent(ruleId)}/review`,
    { method: "POST", headers: authHeaders(jwt), body: JSON.stringify({ action }) },
  )
  if (!res.ok) return parseErrorAndThrow(res, "review style rule failed")
  return ((await res.json()) as { rule: StyleRule }).rule
}

/** PUT …/style-rules/:ruleId/applicability (PROJECT_LEAD+). Upserts on
 * (rule, targetType, targetId). */
export async function putStyleRuleApplicability(
  jwt: string,
  projectId: string,
  ruleId: string,
  row: UpsertApplicabilityInput,
): Promise<RuleApplicability> {
  const res = await fetchWithTimeout(
    `${rulesBase(projectId)}/${encodeURIComponent(ruleId)}/applicability`,
    { method: "PUT", headers: authHeaders(jwt), body: JSON.stringify(row) },
  )
  if (!res.ok) return parseErrorAndThrow(res, "set style-rule applicability failed")
  return ((await res.json()) as { row: RuleApplicability }).row
}

/** DELETE …/style-rules/:ruleId/applicability/:applicabilityId (PROJECT_LEAD+). */
export async function deleteStyleRuleApplicability(
  jwt: string,
  projectId: string,
  ruleId: string,
  applicabilityId: string,
): Promise<void> {
  const res = await fetchWithTimeout(
    `${rulesBase(projectId)}/${encodeURIComponent(ruleId)}/applicability/${encodeURIComponent(applicabilityId)}`,
    { method: "DELETE", headers: authHeaders(jwt) },
  )
  if (!res.ok) return parseErrorAndThrow(res, "remove style-rule applicability failed")
}
