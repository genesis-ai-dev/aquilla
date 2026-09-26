/**
 * style-rules-api.test.ts — fetch-client contract tests for the six style-rule
 * routes. Verifies request shape (URL, method, headers, body) and that non-OK
 * responses surface the RIGHT typed error, mirroring memory-api.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RuleApplicability, StyleRule } from "./style-rule-types"
import {
  createStyleRule,
  deleteStyleRuleApplicability,
  listStyleRules,
  putStyleRuleApplicability,
  reviewStyleRule,
  StyleRuleNotFoundError,
  StyleRulePermissionError,
  StyleRulesApiError,
  updateStyleRule,
} from "./style-rules-api"

const JWT = "jwt-token"
const PROJECT_ID = "proj-1"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function errorResponse(status: number, code?: string, message = "boom"): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

const RULE: StyleRule = {
  id: "rule-1",
  orgId: null,
  projectId: PROJECT_ID,
  instruction: "Render divine names in small caps.",
  category: "formatting",
  scope: "global",
  conditions: null,
  examples: null,
  exceptions: null,
  source: { kind: "knowledge-doc", docId: "doc-1", nodeId: "n1" },
  checkSpec: null,
  severity: "minor",
  enabled: true,
  status: "proposed",
  humanEdited: false,
  provenance: null,
  createdBy: "alice",
  reviewedBy: null,
  version: 1,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
}

const ROW: RuleApplicability = {
  id: "row-1",
  ruleId: RULE.id,
  targetType: "genre",
  targetId: "poetry",
  relationship: "likely_applies",
  confidence: 0.8,
  reason: null,
  assignedBy: "model",
  createdBy: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("listStyleRules", () => {
  it("GETs with the status filter and Authorization header", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ rules: [RULE], applicability: [ROW] }))
    const result = await listStyleRules(JWT, PROJECT_ID, "proposed")
    expect(result.rules).toEqual([RULE])
    expect(result.applicability).toEqual([ROW])
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain(`/api/v2/projects/${PROJECT_ID}/style-rules?status=proposed`)
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${JWT}`)
  })

  it("omits the query string when no status is given", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ rules: [], applicability: [] }))
    await listStyleRules(JWT, PROJECT_ID)
    const [url] = fetchMock.mock.calls[0]
    expect(String(url)).not.toContain("?status=")
  })

  it("throws a generic StyleRulesApiError carrying the envelope code", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(500, "internal", "server exploded"))
    const err = await listStyleRules(JWT, PROJECT_ID).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StyleRulesApiError)
    expect((err as StyleRulesApiError).status).toBe(500)
    expect((err as StyleRulesApiError).code).toBe("internal")
    expect((err as StyleRulesApiError).message).toContain("server exploded")
  })
})

describe("createStyleRule", () => {
  it("POSTs the input body and returns rule + applicability", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ rule: RULE, applicability: [ROW] }, 201))
    const input = {
      instruction: RULE.instruction,
      category: RULE.category,
      scope: RULE.scope,
      applicability: [
        { targetType: "genre", targetId: "poetry", relationship: "likely_applies", assignedBy: "model" } as const,
      ],
    }
    const result = await createStyleRule(JWT, PROJECT_ID, input)
    expect(result.rule).toEqual(RULE)
    expect(result.applicability).toEqual([ROW])
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toMatch(new RegExp(`/projects/${PROJECT_ID}/style-rules$`))
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body as string)).toEqual(input)
  })
})

describe("updateStyleRule", () => {
  it("PATCHes the editable subset", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ rule: { ...RULE, enabled: false } }))
    const updated = await updateStyleRule(JWT, PROJECT_ID, RULE.id, { enabled: false })
    expect(updated.enabled).toBe(false)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain(`/style-rules/${RULE.id}`)
    expect(init.method).toBe("PATCH")
    expect(JSON.parse(init.body as string)).toEqual({ enabled: false })
  })

  it("throws StyleRulePermissionError on 403 permission_denied (org-scoped row)", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(403, "permission_denied", "org rules are read-only here"))
    await expect(updateStyleRule(JWT, PROJECT_ID, RULE.id, { enabled: false })).rejects.toThrow(
      StyleRulePermissionError,
    )
  })
})

describe("reviewStyleRule", () => {
  it("POSTs the action to the review route", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ rule: { ...RULE, status: "approved" } }))
    const reviewed = await reviewStyleRule(JWT, PROJECT_ID, RULE.id, "approve")
    expect(reviewed.status).toBe("approved")
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain(`/style-rules/${RULE.id}/review`)
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body as string)).toEqual({ action: "approve" })
  })

  it("throws StyleRuleNotFoundError on 404 not_found", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(404, "not_found", "gone"))
    await expect(reviewStyleRule(JWT, PROJECT_ID, RULE.id, "reject")).rejects.toThrow(
      StyleRuleNotFoundError,
    )
  })
})

describe("putStyleRuleApplicability", () => {
  it("PUTs the upsert body and unwraps the row", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ row: ROW }))
    const body = {
      targetType: "genre",
      targetId: "poetry",
      relationship: "likely_applies",
      confidence: 0.8,
      assignedBy: "model",
    } as const
    const row = await putStyleRuleApplicability(JWT, PROJECT_ID, RULE.id, body)
    expect(row).toEqual(ROW)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toMatch(new RegExp(`/style-rules/${RULE.id}/applicability$`))
    expect(init.method).toBe("PUT")
    expect(JSON.parse(init.body as string)).toEqual(body)
  })
})

describe("deleteStyleRuleApplicability", () => {
  it("DELETEs the row by id", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    await deleteStyleRuleApplicability(JWT, PROJECT_ID, RULE.id, ROW.id)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain(`/style-rules/${RULE.id}/applicability/${ROW.id}`)
    expect(init.method).toBe("DELETE")
  })

  it("surfaces a typed error on a non-JSON error body", async () => {
    fetchMock.mockResolvedValueOnce(new Response("gateway timeout", { status: 504 }))
    const err = await deleteStyleRuleApplicability(JWT, PROJECT_ID, RULE.id, ROW.id).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(StyleRulesApiError)
    expect((err as StyleRulesApiError).status).toBe(504)
  })
})
