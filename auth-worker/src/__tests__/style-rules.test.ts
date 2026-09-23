// Style-rule library + applicability API (AQU-934 phase 2). WHY: this surface
// is what keeps extracted rules from silently becoming prompt-injected policy —
// anyone CONTRIBUTOR+ may PROPOSE a rule, but only a PROJECT_LEAD review makes
// it part of the approved library, and org-shared rules can never be rewritten
// from inside one project. Each test asserts a specific way those gates (or the
// wire contract WS-B consumes) could fail, not just the happy path.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { ROLE } from "../types"

const PROJECT = "proj-style"
const ORG = 7

async function seedProject(projectId: string, createdBy: number, orgId?: number): Promise<void> {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, created_by, org_id) VALUES (?, ?, ?, ?)",
  )
    .bind(projectId, "Style Project", createdBy, orgId ?? null)
    .run()
}

async function grant(projectId: string, userId: number, role: number): Promise<void> {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, ?, ?)",
  )
    .bind(projectId, userId, role, userId)
    .run()
}

async function seedOrg(orgId: number, ownerId: number): Promise<void> {
  await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)")
    .bind(orgId, "Style Org", ownerId)
    .run()
}

/** Insert an org-scoped rule directly (org routes are out of scope here). */
async function seedOrgRule(id: string, orgId: number, instruction: string): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO style_rules (id, org_id, instruction, category, scope, status)
     VALUES (?, ?, ?, 'style', 'global', 'approved')`,
  )
    .bind(id, orgId, instruction)
    .run()
}

async function seedApplicabilityRow(
  id: string,
  ruleId: string,
  targetType: string,
  targetId: string,
): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO rule_applicability (id, rule_id, target_type, target_id, relationship, assigned_by)
     VALUES (?, ?, ?, ?, 'applies', 'human')`,
  )
    .bind(id, ruleId, targetType, targetId)
    .run()
}

async function req(method: string, path: string, jwt: string, body?: unknown) {
  return app.request(
    `/api/v2/projects/${path}`,
    {
      method,
      headers: authHeader(jwt),
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  )
}

interface WireRule {
  id: string
  orgId: number | null
  projectId: string | null
  instruction: string
  category: string
  scope: string
  severity: string
  enabled: boolean
  status: string
  humanEdited: boolean
  createdBy: string | null
  reviewedBy: string | null
  version: number
  checkSpec: { type: string } | null
  source: { kind: string; docId?: string } | null
  examples: Array<{ before?: string; after?: string; note?: string }> | null
  conditions: string | null
}

interface WireRow {
  id: string
  ruleId: string
  targetType: string
  targetId: string
  relationship: string
  confidence: number | null
  reason: string | null
  assignedBy: string
}

/** Seed lead(1) + project and return the lead's JWT. */
async function leadSetup(): Promise<string> {
  await seedUser(1, "lead")
  await seedProject(PROJECT, 1)
  await grant(PROJECT, 1, ROLE.PROJECT_LEAD)
  return jwtFor("lead")
}

async function createRuleVia(
  jwt: string,
  overrides?: Record<string, unknown>,
): Promise<{ rule: WireRule; applicability: WireRow[]; res: Response }> {
  const res = await req("POST", `${PROJECT}/style-rules`, jwt, {
    instruction: "Render divine names in small caps.",
    category: "formatting",
    scope: "global",
    ...overrides,
  })
  const parsed = (await res.clone().json()) as { rule: WireRule; applicability: WireRow[] }
  return { ...parsed, res }
}

// ──────────────────────────────────────────────────────────────────────────
// Create → proposed (with initial applicability rows)
// ──────────────────────────────────────────────────────────────────────────

describe("style-rule create", () => {
  it("contributor POST creates a proposed rule with its initial applicability rows", async () => {
    await seedUser(1, "lead")
    await seedUser(2, "contrib")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, ROLE.PROJECT_LEAD)
    await grant(PROJECT, 2, ROLE.CONTRIBUTOR)
    const contribJwt = await jwtFor("contrib")

    const res = await req("POST", `${PROJECT}/style-rules`, contribJwt, {
      instruction: "Use parallel line structure in poetry.",
      category: "style",
      scope: "genre",
      conditions: "only in poetic sections",
      examples: [{ before: "flat prose", after: "parallel lines", note: "Hebrew parallelism" }],
      source: { kind: "knowledge-doc", docId: "doc-1", nodeId: "n1.2", quote: "poetry keeps parallelism" },
      checkSpec: { type: "target-forbids", targetPattern: "\\bLORD\\b" },
      severity: "major",
      applicability: [
        { targetType: "genre", targetId: "poetry", relationship: "likely_applies", confidence: 0.8, assignedBy: "model" },
        { targetType: "book", targetId: "PSA", relationship: "applies", assignedBy: "human" },
      ],
    })
    expect(res.status).toBe(201)
    const { rule, applicability } = (await res.json()) as { rule: WireRule; applicability: WireRow[] }

    // Wire shape is camelCase and status is proposed regardless of input.
    expect(rule.status).toBe("proposed")
    expect(rule.projectId).toBe(PROJECT)
    expect(rule.orgId).toBeNull()
    expect(rule.humanEdited).toBe(false)
    expect(rule.version).toBe(1)
    expect(rule.createdBy).toBe("contrib")
    expect(rule.severity).toBe("major")
    expect(rule.checkSpec).toEqual({ type: "target-forbids", targetPattern: "\\bLORD\\b" })
    expect(rule.source).toMatchObject({ kind: "knowledge-doc", docId: "doc-1" })
    expect(rule.examples).toEqual([
      { before: "flat prose", after: "parallel lines", note: "Hebrew parallelism" },
    ])

    // Both initial rows landed with the rule, mapped camelCase.
    expect(applicability).toHaveLength(2)
    const byTarget = Object.fromEntries(applicability.map((r) => [r.targetId, r]))
    expect(byTarget["poetry"]).toMatchObject({
      ruleId: rule.id,
      targetType: "genre",
      relationship: "likely_applies",
      assignedBy: "model",
    })
    expect(byTarget["poetry"].confidence).toBeCloseTo(0.8)
    expect(byTarget["PSA"]).toMatchObject({
      targetType: "book",
      relationship: "applies",
      assignedBy: "human",
      confidence: null,
    })

    // And they are readable back through GET.
    const list = await req("GET", `${PROJECT}/style-rules`, contribJwt)
    expect(list.status).toBe(200)
    const listed = (await list.json()) as { rules: WireRule[]; applicability: WireRow[] }
    expect(listed.rules.map((r) => r.id)).toContain(rule.id)
    expect(listed.applicability.filter((r) => r.ruleId === rule.id)).toHaveLength(2)
  })

  it("a client-sent status is ignored — rules are always born proposed", async () => {
    const leadJwt = await leadSetup()
    const { rule, res } = await createRuleVia(leadJwt, { status: "approved" })
    expect(res.status).toBe(201)
    expect(rule.status).toBe("proposed")
  })

  it("defaults severity to minor and enabled to true", async () => {
    const leadJwt = await leadSetup()
    const { rule } = await createRuleVia(leadJwt)
    expect(rule.severity).toBe("minor")
    expect(rule.enabled).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// List: project + inherited org rows, applicability covers returned rules
// ──────────────────────────────────────────────────────────────────────────

describe("style-rule list + org inheritance", () => {
  it("returns project rows AND the project's org rows, each with applicability", async () => {
    await seedUser(1, "lead")
    await seedOrg(ORG, 1)
    await seedProject(PROJECT, 1, ORG)
    await grant(PROJECT, 1, ROLE.PROJECT_LEAD)
    const leadJwt = await jwtFor("lead")

    const { rule: projectRule } = await createRuleVia(leadJwt, {
      applicability: [{ targetType: "book", targetId: "LUK", relationship: "applies", assignedBy: "human" }],
    })
    await seedOrgRule("org-rule-1", ORG, "Org-wide: avoid archaic pronouns.")
    await seedApplicabilityRow("org-appl-1", "org-rule-1", "genre", "epistle")

    const res = await req("GET", `${PROJECT}/style-rules`, leadJwt)
    expect(res.status).toBe(200)
    const { rules, applicability } = (await res.json()) as {
      rules: WireRule[]
      applicability: WireRow[]
    }
    const ids = rules.map((r) => r.id)
    expect(ids).toContain(projectRule.id)
    expect(ids).toContain("org-rule-1")
    const orgRow = rules.find((r) => r.id === "org-rule-1")
    expect(orgRow).toMatchObject({ orgId: ORG, projectId: null, status: "approved" })
    // Applicability covers BOTH the project rule's and the org rule's rows.
    expect(applicability.map((r) => r.id)).toContain("org-appl-1")
    expect(applicability.some((r) => r.ruleId === projectRule.id && r.targetId === "LUK")).toBe(true)
  })

  it("?status= filters rules AND restricts applicability to the returned rules", async () => {
    const leadJwt = await leadSetup()
    const { rule: kept } = await createRuleVia(leadJwt, {
      applicability: [{ targetType: "book", targetId: "PSA", relationship: "applies", assignedBy: "human" }],
    })
    const { rule: approved } = await createRuleVia(leadJwt, {
      instruction: "Second rule.",
      applicability: [{ targetType: "book", targetId: "GEN", relationship: "applies", assignedBy: "human" }],
    })
    await req("POST", `${PROJECT}/style-rules/${approved.id}/review`, leadJwt, { action: "approve" })

    const res = await req("GET", `${PROJECT}/style-rules?status=proposed`, leadJwt)
    const { rules, applicability } = (await res.json()) as {
      rules: WireRule[]
      applicability: WireRow[]
    }
    expect(rules.map((r) => r.id)).toEqual([kept.id])
    expect(applicability.every((r) => r.ruleId === kept.id)).toBe(true)
  })

  it("rejects an unknown status filter with validation_failed", async () => {
    const leadJwt = await leadSetup()
    const res = await req("GET", `${PROJECT}/style-rules?status=bogus`, leadJwt)
    expect(res.status).toBe(400)
    const err = (await res.json()) as { error: { code: string } }
    expect(err.error.code).toBe("validation_failed")
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Role floors
// ──────────────────────────────────────────────────────────────────────────

describe("style-rule role floors", () => {
  async function floorsSetup(): Promise<{ lead: string; contrib: string; viewer: string; ruleId: string }> {
    await seedUser(1, "lead")
    await seedUser(2, "contrib")
    await seedUser(3, "viewer")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, ROLE.PROJECT_LEAD)
    await grant(PROJECT, 2, ROLE.CONTRIBUTOR)
    await grant(PROJECT, 3, ROLE.VIEWER)
    const lead = await jwtFor("lead")
    const contrib = await jwtFor("contrib")
    const viewer = await jwtFor("viewer")
    const { rule } = await createRuleVia(contrib)
    return { lead, contrib, viewer, ruleId: rule.id }
  }

  it("viewer can read but not propose", async () => {
    const { viewer } = await floorsSetup()
    const list = await req("GET", `${PROJECT}/style-rules`, viewer)
    expect(list.status).toBe(200)
    const post = await req("POST", `${PROJECT}/style-rules`, viewer, {
      instruction: "x",
      category: "style",
      scope: "global",
    })
    expect(post.status).toBe(403)
    const err = (await post.json()) as { error: { code: string } }
    expect(err.error.code).toBe("permission_denied")
  })

  it("contributor can propose but not review, PATCH, or write applicability", async () => {
    const { contrib, ruleId } = await floorsSetup()
    const review = await req("POST", `${PROJECT}/style-rules/${ruleId}/review`, contrib, {
      action: "approve",
    })
    expect(review.status).toBe(403)
    const patch = await req("PATCH", `${PROJECT}/style-rules/${ruleId}`, contrib, { enabled: false })
    expect(patch.status).toBe(403)
    const put = await req("PUT", `${PROJECT}/style-rules/${ruleId}/applicability`, contrib, {
      targetType: "book",
      targetId: "PSA",
      relationship: "applies",
      assignedBy: "human",
    })
    expect(put.status).toBe(403)
    const del = await req(
      "DELETE",
      `${PROJECT}/style-rules/${ruleId}/applicability/whatever`,
      contrib,
    )
    expect(del.status).toBe(403)
  })

  it("non-member cannot even read", async () => {
    await floorsSetup()
    await seedUser(9, "outsider")
    const outsider = await jwtFor("outsider")
    const res = await req("GET", `${PROJECT}/style-rules`, outsider)
    expect(res.status).toBe(403)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Review lifecycle
// ──────────────────────────────────────────────────────────────────────────

describe("style-rule review", () => {
  it("lead approve sets status=approved and reviewedBy", async () => {
    const leadJwt = await leadSetup()
    const { rule } = await createRuleVia(leadJwt)
    const res = await req("POST", `${PROJECT}/style-rules/${rule.id}/review`, leadJwt, {
      action: "approve",
    })
    expect(res.status).toBe(200)
    const { rule: reviewed } = (await res.json()) as { rule: WireRule }
    expect(reviewed.status).toBe("approved")
    expect(reviewed.reviewedBy).toBe("lead")
  })

  it("reject sets status=rejected; reviewing a non-proposed rule → 409", async () => {
    const leadJwt = await leadSetup()
    const { rule } = await createRuleVia(leadJwt)
    const rej = await req("POST", `${PROJECT}/style-rules/${rule.id}/review`, leadJwt, {
      action: "reject",
    })
    expect(rej.status).toBe(200)
    const { rule: rejected } = (await rej.json()) as { rule: WireRule }
    expect(rejected.status).toBe("rejected")

    // A second review of the now-rejected rule is an invalid state.
    const again = await req("POST", `${PROJECT}/style-rules/${rule.id}/review`, leadJwt, {
      action: "approve",
    })
    expect(again.status).toBe(409)
    const err = (await again.json()) as { error: { code: string } }
    expect(err.error.code).toBe("validation_failed")
  })

  it("reviewing an unknown rule → 404", async () => {
    const leadJwt = await leadSetup()
    const res = await req("POST", `${PROJECT}/style-rules/nope/review`, leadJwt, {
      action: "approve",
    })
    expect(res.status).toBe(404)
    const err = (await res.json()) as { error: { code: string } }
    expect(err.error.code).toBe("not_found")
  })
})

// ──────────────────────────────────────────────────────────────────────────
// PATCH (human edit)
// ──────────────────────────────────────────────────────────────────────────

describe("style-rule PATCH", () => {
  it("sets human_edited=true and bumps version; null clears a nullable field", async () => {
    const leadJwt = await leadSetup()
    const { rule } = await createRuleVia(leadJwt, { conditions: "only in direct speech" })
    const res = await req("PATCH", `${PROJECT}/style-rules/${rule.id}`, leadJwt, {
      instruction: "Render divine names in SMALL CAPS.",
      severity: "major",
      enabled: false,
      conditions: null,
    })
    expect(res.status).toBe(200)
    const { rule: edited } = (await res.json()) as { rule: WireRule }
    expect(edited.humanEdited).toBe(true)
    expect(edited.version).toBe(2)
    expect(edited.instruction).toBe("Render divine names in SMALL CAPS.")
    expect(edited.severity).toBe("major")
    expect(edited.enabled).toBe(false)
    expect(edited.conditions).toBeNull()
  })

  it("an empty patch → validation_failed", async () => {
    const leadJwt = await leadSetup()
    const { rule } = await createRuleVia(leadJwt)
    const res = await req("PATCH", `${PROJECT}/style-rules/${rule.id}`, leadJwt, {})
    expect(res.status).toBe(400)
    const err = (await res.json()) as { error: { code: string } }
    expect(err.error.code).toBe("validation_failed")
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Applicability upsert / delete
// ──────────────────────────────────────────────────────────────────────────

describe("style-rule applicability", () => {
  it("PUT upserts: the second write on the same (targetType,targetId) replaces the row", async () => {
    const leadJwt = await leadSetup()
    const { rule } = await createRuleVia(leadJwt)

    const first = await req("PUT", `${PROJECT}/style-rules/${rule.id}/applicability`, leadJwt, {
      targetType: "book",
      targetId: "PSA",
      relationship: "likely_applies",
      confidence: 0.5,
      reason: "model guess",
      assignedBy: "model",
    })
    expect(first.status).toBe(200)
    const { row: row1 } = (await first.json()) as { row: WireRow }

    const second = await req("PUT", `${PROJECT}/style-rules/${rule.id}/applicability`, leadJwt, {
      targetType: "book",
      targetId: "PSA",
      relationship: "excluded",
      reason: "human override",
      assignedBy: "human",
    })
    expect(second.status).toBe(200)
    const { row: row2 } = (await second.json()) as { row: WireRow }

    // Same row identity, replaced payload.
    expect(row2.id).toBe(row1.id)
    expect(row2).toMatchObject({
      targetType: "book",
      targetId: "PSA",
      relationship: "excluded",
      reason: "human override",
      assignedBy: "human",
      confidence: null,
    })

    // Exactly one row exists for the key.
    const list = await req("GET", `${PROJECT}/style-rules`, leadJwt)
    const { applicability } = (await list.json()) as { applicability: WireRow[] }
    expect(applicability.filter((r) => r.ruleId === rule.id)).toHaveLength(1)
  })

  it("DELETE removes the row; deleting it again → 404", async () => {
    const leadJwt = await leadSetup()
    const { rule } = await createRuleVia(leadJwt)
    const put = await req("PUT", `${PROJECT}/style-rules/${rule.id}/applicability`, leadJwt, {
      targetType: "segment",
      targetId: "cell-123",
      relationship: "excluded",
      assignedBy: "human",
    })
    const { row } = (await put.json()) as { row: WireRow }

    const del = await req(
      "DELETE",
      `${PROJECT}/style-rules/${rule.id}/applicability/${row.id}`,
      leadJwt,
    )
    expect(del.status).toBe(200)
    expect((await del.json()) as { ok: boolean }).toEqual({ ok: true })

    const list = await req("GET", `${PROJECT}/style-rules`, leadJwt)
    const { applicability } = (await list.json()) as { applicability: WireRow[] }
    expect(applicability.filter((r) => r.ruleId === rule.id)).toHaveLength(0)

    const again = await req(
      "DELETE",
      `${PROJECT}/style-rules/${rule.id}/applicability/${row.id}`,
      leadJwt,
    )
    expect(again.status).toBe(404)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Org rows are read-only through project routes (knowledge.ts precedent)
// ──────────────────────────────────────────────────────────────────────────

describe("org-rule write refusal via project routes", () => {
  async function orgSetup(): Promise<string> {
    await seedUser(1, "lead")
    await seedOrg(ORG, 1)
    await seedProject(PROJECT, 1, ORG)
    await grant(PROJECT, 1, ROLE.PROJECT_LEAD)
    await seedOrgRule("org-rule-ro", ORG, "Org-wide rule.")
    return jwtFor("lead")
  }

  it("PATCH / review / applicability writes on an org rule → 403 permission_denied", async () => {
    const leadJwt = await orgSetup()
    // Force the org row back to proposed so the review path is the one refusing.
    await env.AQUILLA_PG.prepare("UPDATE style_rules SET status = 'proposed' WHERE id = ?")
      .bind("org-rule-ro")
      .run()

    for (const attempt of [
      () => req("PATCH", `${PROJECT}/style-rules/org-rule-ro`, leadJwt, { enabled: false }),
      () => req("POST", `${PROJECT}/style-rules/org-rule-ro/review`, leadJwt, { action: "approve" }),
      () =>
        req("PUT", `${PROJECT}/style-rules/org-rule-ro/applicability`, leadJwt, {
          targetType: "book",
          targetId: "PSA",
          relationship: "applies",
          assignedBy: "human",
        }),
      () => req("DELETE", `${PROJECT}/style-rules/org-rule-ro/applicability/some-id`, leadJwt),
    ]) {
      const res = await attempt()
      expect(res.status).toBe(403)
      const err = (await res.json()) as { error: { code: string } }
      expect(err.error.code).toBe("permission_denied")
    }
    // The org row is untouched.
    const row = await env.AQUILLA_PG.prepare("SELECT enabled, status FROM style_rules WHERE id = ?")
      .bind("org-rule-ro")
      .first<{ enabled: boolean; status: string }>()
    expect(row).toMatchObject({ enabled: true, status: "proposed" })
  })

  it("a rule belonging to an unrelated project is invisible → 404", async () => {
    const leadJwt = await orgSetup()
    await seedProject("other-proj", 1)
    await env.AQUILLA_PG.prepare(
      `INSERT INTO style_rules (id, project_id, instruction) VALUES (?, ?, ?)`,
    )
      .bind("foreign-rule", "other-proj", "Foreign rule.")
      .run()
    const res = await req("PATCH", `${PROJECT}/style-rules/foreign-rule`, leadJwt, {
      enabled: false,
    })
    expect(res.status).toBe(404)
    const err = (await res.json()) as { error: { code: string } }
    expect(err.error.code).toBe("not_found")
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Validation — enums must match the SQL CHECK lists exactly
// ──────────────────────────────────────────────────────────────────────────

describe("style-rule validation", () => {
  it("rejects bad enums on create with validation_failed", async () => {
    const leadJwt = await leadSetup()
    const bodies: Array<Record<string, unknown>> = [
      { instruction: "x", category: "tone", scope: "global" }, // bad category
      { instruction: "x", category: "style", scope: "chapter" }, // bad scope
      { instruction: "x", category: "style", scope: "global", severity: "critical" }, // bad severity
      {
        instruction: "x",
        category: "style",
        scope: "global",
        applicability: [
          { targetType: "verse", targetId: "PSA 1:1", relationship: "applies", assignedBy: "human" },
        ],
      }, // bad targetType
      {
        instruction: "x",
        category: "style",
        scope: "global",
        applicability: [
          { targetType: "book", targetId: "PSA", relationship: "maybe", assignedBy: "human" },
        ],
      }, // bad relationship
      { category: "style", scope: "global" }, // missing instruction
    ]
    for (const body of bodies) {
      const res = await req("POST", `${PROJECT}/style-rules`, leadJwt, body)
      expect(res.status).toBe(400)
      const err = (await res.json()) as { error: { code: string } }
      expect(err.error.code).toBe("validation_failed")
    }
  })

  it("rejects a bad enum on PATCH and a bad assignedBy on PUT applicability", async () => {
    const leadJwt = await leadSetup()
    const { rule } = await createRuleVia(leadJwt)

    const patch = await req("PATCH", `${PROJECT}/style-rules/${rule.id}`, leadJwt, {
      category: "voice",
    })
    expect(patch.status).toBe(400)
    expect(((await patch.json()) as { error: { code: string } }).error.code).toBe(
      "validation_failed",
    )

    const put = await req("PUT", `${PROJECT}/style-rules/${rule.id}/applicability`, leadJwt, {
      targetType: "book",
      targetId: "PSA",
      relationship: "applies",
      assignedBy: "robot",
    })
    expect(put.status).toBe(400)
    expect(((await put.json()) as { error: { code: string } }).error.code).toBe("validation_failed")
  })

  it("rejects a malformed checkSpec but accepts each RuleCheck variant", async () => {
    const leadJwt = await leadSetup()
    const bad = await req("POST", `${PROJECT}/style-rules`, leadJwt, {
      instruction: "x",
      category: "style",
      scope: "global",
      checkSpec: { type: "regex-anything", pattern: "x" },
    })
    expect(bad.status).toBe(400)

    for (const checkSpec of [
      { type: "source-requires-target", sourcePattern: "a", targetPattern: "b" },
      { type: "target-forbids", targetPattern: "b" },
      { type: "source-target-match", pattern: "c" },
      { type: "builtin", checkId: "untranslated" },
    ]) {
      const ok = await req("POST", `${PROJECT}/style-rules`, leadJwt, {
        instruction: "x",
        category: "style",
        scope: "global",
        checkSpec,
      })
      expect(ok.status).toBe(201)
    }
  })
})
