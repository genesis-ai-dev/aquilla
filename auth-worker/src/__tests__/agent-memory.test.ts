// Agent memory + project brief API (AQU-AGENT contracts §3, owner W1C). WHY:
// this surface is the ONLY thing that keeps an autonomous agent from silently
// rewriting a project's institutional memory. The tests encode the gate that
// matters: an agent may PROPOSE, but a human must APPROVE — except in the one
// narrowly-scoped autonomy mode, and never for the brief. Each test asserts a
// specific way that gate can fail open, not just that the happy path returns 200.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { buildMemoryContext } from "../../../db/shared/agent-memory"

const PROJECT = "proj-mem"

async function seedProject(projectId: string, createdBy: number): Promise<void> {
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, ?)")
    .bind(projectId, "Mem Project", createdBy)
    .run()
}

async function grant(projectId: string, userId: number, role: number): Promise<void> {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, ?, ?)",
  )
    .bind(projectId, userId, role, userId)
    .run()
}

async function setAutonomy(projectId: string, autonomy: string): Promise<void> {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES (?, ?, 1, 1)",
  )
    .bind(projectId, JSON.stringify({ agentMemoryAutonomy: autonomy }))
    .run()
}

/** Headers with the agent-run channel marker set. */
function agentHeader(jwt: string, runId = "run-1"): Record<string, string> {
  return { ...authHeader(jwt), "x-aquilla-agent-run": runId }
}

async function req(
  method: string,
  path: string,
  jwt: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
) {
  const headers = extraHeaders ?? authHeader(jwt)
  return app.request(
    `/api/v2/projects/${path}`,
    { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
    env,
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Propose → approve → supersede; reject
// ──────────────────────────────────────────────────────────────────────────

describe("memory propose → review lifecycle", () => {
  it("contributor proposes, lead approves, a second approval supersedes the first", async () => {
    await seedUser(1, "lead")
    await seedUser(2, "contrib")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, 500) // project_lead
    await grant(PROJECT, 2, 400) // contributor
    const leadJwt = await jwtFor("lead")
    const contribJwt = await jwtFor("contrib")

    // Contributor proposes v1.
    const p1 = await req("POST", `${PROJECT}/agent-memory`, contribJwt, {
      path: "glossary/grace.md",
      content: "grace → gracia",
      rationale: "term decision",
    })
    expect(p1.status).toBe(201)
    const { memoryId: id1 } = (await p1.json()) as { memoryId: string }

    // Lead approves v1.
    const a1 = await req("POST", `${PROJECT}/agent-memory/${id1}/review`, leadJwt, {
      action: "approve",
    })
    expect(a1.status).toBe(200)
    const approved1 = (await a1.json()) as { memory: { status: string } }
    expect(approved1.memory.status).toBe("approved")

    // A second proposal on the SAME path, approved → supersedes the first.
    const p2 = await req("POST", `${PROJECT}/agent-memory`, contribJwt, {
      path: "glossary/grace.md",
      content: "grace → gracia (revised)",
    })
    const { memoryId: id2 } = (await p2.json()) as { memoryId: string }
    const a2 = await req("POST", `${PROJECT}/agent-memory/${id2}/review`, leadJwt, {
      action: "approve",
    })
    expect(a2.status).toBe(200)

    // Old row archived, new row approved — the partial unique index held.
    const list = await req("GET", `${PROJECT}/agent-memory`, leadJwt)
    const { memories } = (await list.json()) as { memories: Array<{ id: string; status: string }> }
    const byId = Object.fromEntries(memories.map((m) => [m.id, m.status]))
    expect(byId[id1]).toBe("archived")
    expect(byId[id2]).toBe("approved")
  })

  it("rejects a proposal without archiving anything", async () => {
    await seedUser(1, "lead")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, 500)
    const leadJwt = await jwtFor("lead")

    const p = await req("POST", `${PROJECT}/agent-memory`, leadJwt, {
      path: "notes/x.md",
      content: "nope",
    })
    const { memoryId } = (await p.json()) as { memoryId: string }
    const r = await req("POST", `${PROJECT}/agent-memory/${memoryId}/review`, leadJwt, {
      action: "reject",
    })
    expect(r.status).toBe(200)
    const { memory } = (await r.json()) as { memory: { status: string } }
    expect(memory.status).toBe("rejected")
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Human edit + human-edit protection
// ──────────────────────────────────────────────────────────────────────────

describe("human edit protection", () => {
  it("human PATCH sets human_edited=true and bumps version", async () => {
    await seedUser(1, "lead")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, 500)
    const leadJwt = await jwtFor("lead")

    const p = await req("POST", `${PROJECT}/agent-memory`, leadJwt, {
      path: "notes/y.md",
      content: "v1",
    })
    const { memoryId } = (await p.json()) as { memoryId: string }
    const patch = await req("PATCH", `${PROJECT}/agent-memory/${memoryId}`, leadJwt, {
      content: "v2 human",
    })
    expect(patch.status).toBe(200)
    const { memory } = (await patch.json()) as {
      memory: { humanEdited: boolean; version: number; content: string }
    }
    expect(memory.humanEdited).toBe(true)
    expect(memory.version).toBe(2)
    expect(memory.content).toBe("v2 human")
  })

  it("agent-channel PATCH on a human_edited row → 403 human_edit_protected", async () => {
    await seedUser(1, "lead")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, 500)
    const leadJwt = await jwtFor("lead")

    const p = await req("POST", `${PROJECT}/agent-memory`, leadJwt, { path: "notes/z.md", content: "v1" })
    const { memoryId } = (await p.json()) as { memoryId: string }
    // Human edits first → human_edited=true.
    await req("PATCH", `${PROJECT}/agent-memory/${memoryId}`, leadJwt, { content: "human" })

    // Agent channel now tries to PATCH → blocked.
    const agentPatch = await req(
      "PATCH",
      `${PROJECT}/agent-memory/${memoryId}`,
      leadJwt,
      { content: "agent overwrite" },
      agentHeader(leadJwt),
    )
    expect(agentPatch.status).toBe(403)
    const err = (await agentPatch.json()) as { error: { code: string } }
    expect(err.error.code).toBe("human_edit_protected")
  })

  it("agent-channel PATCH on a NON-human-edited row → 403 agent_edit_forbidden (agents propose, never edit)", async () => {
    await seedUser(1, "lead")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, 500)
    const leadJwt = await jwtFor("lead")

    const p = await req("POST", `${PROJECT}/agent-memory`, leadJwt, { path: "notes/agent-target.md", content: "v1" })
    const { memoryId } = (await p.json()) as { memoryId: string }

    // Agent channel PATCH with no prior human edit: would launder agent output
    // into the protected human_edited state — must be rejected outright.
    const agentPatch = await req(
      "PATCH",
      `${PROJECT}/agent-memory/${memoryId}`,
      leadJwt,
      { content: "agent overwrite" },
      agentHeader(leadJwt),
    )
    expect(agentPatch.status).toBe(403)
    const err = (await agentPatch.json()) as { error: { code: string } }
    expect(err.error.code).toBe("agent_edit_forbidden")

    // Row untouched: still v1, not human_edited.
    const list = await req("GET", `${PROJECT}/agent-memory?status=proposed`, leadJwt)
    const { memories } = (await list.json()) as { memories: Array<{ id: string; content: string; humanEdited: boolean }> }
    const row = memories.find((m) => m.id === memoryId)
    expect(row?.content).toBe("v1")
    expect(row?.humanEdited).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Agent-channel review autonomy gate
// ──────────────────────────────────────────────────────────────────────────

describe("agent-channel memory review autonomy", () => {
  it("agent review under default (human) autonomy → 403", async () => {
    await seedUser(1, "lead")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, 500)
    const leadJwt = await jwtFor("lead")

    const p = await req("POST", `${PROJECT}/agent-memory`, leadJwt, {
      path: "observations/a.md",
      content: "seen",
    })
    const { memoryId } = (await p.json()) as { memoryId: string }
    // No project_settings row → autonomy defaults to 'human'.
    const r = await req(
      "POST",
      `${PROJECT}/agent-memory/${memoryId}/review`,
      leadJwt,
      { action: "approve" },
      agentHeader(leadJwt),
    )
    expect(r.status).toBe(403)
    const err = (await r.json()) as { error: { code: string } }
    expect(err.error.code).toBe("agent_review_denied")
  })

  it("agent review of observations/ under agent-low-risk → allowed", async () => {
    await seedUser(1, "lead")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, 500)
    await setAutonomy(PROJECT, "agent-low-risk")
    const leadJwt = await jwtFor("lead")

    const p = await req("POST", `${PROJECT}/agent-memory`, leadJwt, {
      path: "observations/b.md",
      content: "seen",
    })
    const { memoryId } = (await p.json()) as { memoryId: string }
    const r = await req(
      "POST",
      `${PROJECT}/agent-memory/${memoryId}/review`,
      leadJwt,
      { action: "approve" },
      agentHeader(leadJwt),
    )
    expect(r.status).toBe(200)
    const { memory } = (await r.json()) as { memory: { status: string } }
    expect(memory.status).toBe("approved")
  })

  it("agent review of a NON-observations path under agent-low-risk → 403", async () => {
    await seedUser(1, "lead")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, 500)
    await setAutonomy(PROJECT, "agent-low-risk")
    const leadJwt = await jwtFor("lead")

    const p = await req("POST", `${PROJECT}/agent-memory`, leadJwt, {
      path: "glossary/c.md",
      content: "term",
    })
    const { memoryId } = (await p.json()) as { memoryId: string }
    const r = await req(
      "POST",
      `${PROJECT}/agent-memory/${memoryId}/review`,
      leadJwt,
      { action: "approve" },
      agentHeader(leadJwt),
    )
    expect(r.status).toBe(403)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Supersede guard (adversarial-panel B1/B2): approving must not silently
// overwrite a HUMAN-EDITED approved memory. WHY: a human edit is the human's
// authoritative word; the agent (and even a hasty human) must not clobber it
// without an explicit, deliberate confirmation.
// ──────────────────────────────────────────────────────────────────────────

describe("supersede human-edited memory guard", () => {
  /** Create an APPROVED, human-edited memory at `path`; return its id. */
  async function humanEditedApproved(path: string, leadJwt: string): Promise<string> {
    const p = await req("POST", `${PROJECT}/agent-memory`, leadJwt, { path, content: "v1" })
    const { memoryId } = (await p.json()) as { memoryId: string }
    await req("POST", `${PROJECT}/agent-memory/${memoryId}/review`, leadJwt, { action: "approve" })
    // Human edit → human_edited=true, still approved (holds the path).
    await req("PATCH", `${PROJECT}/agent-memory/${memoryId}`, leadJwt, { content: "human word" })
    return memoryId
  }

  it("human approve over a human-edited row → 409 supersedes_human_edited (with details)", async () => {
    await seedUser(1, "lead")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, 500)
    const leadJwt = await jwtFor("lead")
    const existingId = await humanEditedApproved("glossary/g.md", leadJwt)

    // A second proposal on the same path; approving would archive the human row.
    const p2 = await req("POST", `${PROJECT}/agent-memory`, leadJwt, { path: "glossary/g.md", content: "v2" })
    const { memoryId: id2 } = (await p2.json()) as { memoryId: string }
    const a2 = await req("POST", `${PROJECT}/agent-memory/${id2}/review`, leadJwt, { action: "approve" })
    expect(a2.status).toBe(409)
    const err = (await a2.json()) as { error: { code: string; details: { path: string; existingId: string } } }
    expect(err.error.code).toBe("supersedes_human_edited")
    expect(err.error.details).toMatchObject({ path: "glossary/g.md", existingId })
  })

  it("human approve WITH supersedeHumanEdited → succeeds and archives the human row", async () => {
    await seedUser(1, "lead")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, 500)
    const leadJwt = await jwtFor("lead")
    const existingId = await humanEditedApproved("glossary/g.md", leadJwt)

    const p2 = await req("POST", `${PROJECT}/agent-memory`, leadJwt, { path: "glossary/g.md", content: "v2" })
    const { memoryId: id2 } = (await p2.json()) as { memoryId: string }
    const a2 = await req("POST", `${PROJECT}/agent-memory/${id2}/review`, leadJwt, {
      action: "approve",
      supersedeHumanEdited: true,
    })
    expect(a2.status).toBe(200)

    const list = await req("GET", `${PROJECT}/agent-memory`, leadJwt)
    const { memories } = (await list.json()) as { memories: Array<{ id: string; status: string }> }
    const byId = Object.fromEntries(memories.map((m) => [m.id, m.status]))
    expect(byId[existingId]).toBe("archived")
    expect(byId[id2]).toBe("approved")
  })

  it("agent-channel approve over a human-edited row → 403 EVEN WITH the flag", async () => {
    await seedUser(1, "lead")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, 500)
    await setAutonomy(PROJECT, "agent-low-risk")
    const leadJwt = await jwtFor("lead")
    // observations/ path so the autonomy gate would otherwise allow the review.
    await humanEditedApproved("observations/o.md", leadJwt)

    const p2 = await req("POST", `${PROJECT}/agent-memory`, leadJwt, {
      path: "observations/o.md",
      content: "agent v2",
    })
    const { memoryId: id2 } = (await p2.json()) as { memoryId: string }
    const a2 = await req(
      "POST",
      `${PROJECT}/agent-memory/${id2}/review`,
      leadJwt,
      { action: "approve", supersedeHumanEdited: true }, // flag is IGNORED for agents
      agentHeader(leadJwt),
    )
    expect(a2.status).toBe(403)
    const err = (await a2.json()) as { error: { code: string } }
    expect(err.error.code).toBe("supersedes_human_edited")
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Agent-channel membership (adversarial-panel authz-M1): the agent still acts
// as a project member — a non-member cannot reach the review path even under
// agent-low-risk autonomy.
// ──────────────────────────────────────────────────────────────────────────

describe("agent-channel review membership", () => {
  it("non-member with the agent header on an agent-low-risk project → 403", async () => {
    await seedUser(1, "lead")
    await seedUser(4, "outsider") // valid user, NOT a project member
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, 500)
    await setAutonomy(PROJECT, "agent-low-risk")
    const leadJwt = await jwtFor("lead")
    const outsiderJwt = await jwtFor("outsider")

    // Lead proposes an observations/ memory (would be agent-reviewable).
    const p = await req("POST", `${PROJECT}/agent-memory`, leadJwt, {
      path: "observations/m.md",
      content: "seen",
    })
    const { memoryId } = (await p.json()) as { memoryId: string }

    // Non-member sends the agent header — must be denied BEFORE the autonomy gate.
    const r = await req(
      "POST",
      `${PROJECT}/agent-memory/${memoryId}/review`,
      outsiderJwt,
      { action: "approve" },
      agentHeader(outsiderJwt),
    )
    expect(r.status).toBe(403)
    const err = (await r.json()) as { error: { code: string } }
    expect(err.error.code).toBe("permission_denied")
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Validation — secrets + path shape
// ──────────────────────────────────────────────────────────────────────────

describe("memory content/path validation", () => {
  it("rejects content matching a secret pattern", async () => {
    await seedUser(1, "lead")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, 500)
    const leadJwt = await jwtFor("lead")

    for (const content of ["token=aqk_abc123", "key sk-live-xyz", "AKIAABCDEFGHIJKLMNOP", "password: hunter2", "-----BEGIN RSA"]) {
      const r = await req("POST", `${PROJECT}/agent-memory`, leadJwt, { path: "notes/s.md", content })
      expect(r.status).toBe(400)
      const err = (await r.json()) as { error: { code: string } }
      expect(err.error.code).toBe("validation_failed")
    }
  })

  it("rejects an invalid path shape", async () => {
    await seedUser(1, "lead")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, 500)
    const leadJwt = await jwtFor("lead")

    for (const path of ["Notes/x.md", "notes/x.txt", "../escape.md", "notes/x"]) {
      const r = await req("POST", `${PROJECT}/agent-memory`, leadJwt, { path, content: "ok" })
      expect(r.status).toBe(400)
    }
  })

  it("propose requires contributor (viewer → 403)", async () => {
    await seedUser(3, "viewer")
    await seedProject(PROJECT, 99)
    await grant(PROJECT, 3, 100) // viewer
    const jwt = await jwtFor("viewer")
    const r = await req("POST", `${PROJECT}/agent-memory`, jwt, { path: "notes/v.md", content: "x" })
    expect(r.status).toBe(403)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Brief
// ──────────────────────────────────────────────────────────────────────────

describe("project brief", () => {
  it("lead PUT writes the brief; version conflict → 409", async () => {
    await seedUser(1, "lead")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, 500)
    const leadJwt = await jwtFor("lead")

    // First write requires ifMatchVersion=0.
    const w1 = await req("PUT", `${PROJECT}/brief`, leadJwt, {
      content: "Translate Genesis into Swahili.",
      ifMatchVersion: 0,
    })
    expect(w1.status).toBe(200)
    const { brief } = (await w1.json()) as { brief: { version: number; content: string } }
    expect(brief.version).toBe(1)

    // Stale version → conflict.
    const stale = await req("PUT", `${PROJECT}/brief`, leadJwt, {
      content: "clobber",
      ifMatchVersion: 0,
    })
    expect(stale.status).toBe(409)
    const err = (await stale.json()) as { error: { code: string } }
    expect(err.error.code).toBe("conflict")

    // Correct version → succeeds, bumps to 2.
    const w2 = await req("PUT", `${PROJECT}/brief`, leadJwt, {
      content: "Revised brief.",
      ifMatchVersion: 1,
    })
    expect(w2.status).toBe(200)
    const { brief: b2 } = (await w2.json()) as { brief: { version: number } }
    expect(b2.version).toBe(2)
  })

  it("brief PUT via the agent channel → 403 brief_human_only", async () => {
    await seedUser(1, "lead")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, 500)
    const leadJwt = await jwtFor("lead")
    const r = await req(
      "PUT",
      `${PROJECT}/brief`,
      leadJwt,
      { content: "agent tried", ifMatchVersion: 0 },
      agentHeader(leadJwt),
    )
    expect(r.status).toBe(403)
    const err = (await r.json()) as { error: { code: string } }
    expect(err.error.code).toBe("brief_human_only")
  })

  it("agent proposes a brief edit; lead lists then approves it (applies to brief)", async () => {
    await seedUser(1, "lead")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, 500)
    const leadJwt = await jwtFor("lead")

    // Agent channel may propose.
    const prop = await req(
      "POST",
      `${PROJECT}/brief/proposals`,
      leadJwt,
      { content: "Add a pronunciation guide.", rationale: "observed gap" },
      agentHeader(leadJwt),
    )
    expect(prop.status).toBe(201)
    const { proposalId } = (await prop.json()) as { proposalId: string }

    // W1E addendum: list brief proposals (VIEWER+).
    const list = await req("GET", `${PROJECT}/brief/proposals?status=proposed`, leadJwt)
    expect(list.status).toBe(200)
    const { proposals } = (await list.json()) as { proposals: Array<{ id: string; content: string }> }
    expect(proposals.map((p) => p.id)).toContain(proposalId)

    // Agent may NOT review a brief proposal.
    const agentReview = await req(
      "POST",
      `${PROJECT}/brief/proposals/${proposalId}/review`,
      leadJwt,
      { action: "approve" },
      agentHeader(leadJwt),
    )
    expect(agentReview.status).toBe(403)

    // Human lead approves → proposal approved AND brief adopts the content.
    const review = await req("POST", `${PROJECT}/brief/proposals/${proposalId}/review`, leadJwt, {
      action: "approve",
    })
    expect(review.status).toBe(200)
    const brief = await req("GET", `${PROJECT}/brief`, leadJwt)
    const { brief: b } = (await brief.json()) as { brief: { content: string } }
    expect(b.content).toBe("Add a pronunciation guide.")
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Brief base_version + history (adversarial-panel mem-M2/M3): a proposal
// drafted against version N must not silently clobber a human edit that lands
// as N+1 between propose and approve; every brief write snapshots prior content.
// ──────────────────────────────────────────────────────────────────────────

describe("brief base_version + history", () => {
  it("putBrief snapshots prior content into project_brief_history", async () => {
    await seedUser(1, "lead")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, 500)
    const leadJwt = await jwtFor("lead")

    await req("PUT", `${PROJECT}/brief`, leadJwt, { content: "A", ifMatchVersion: 0 })
    await req("PUT", `${PROJECT}/brief`, leadJwt, { content: "B", ifMatchVersion: 1 })

    const rows = await env.AQUILLA_PG.prepare(
      "SELECT version, content FROM project_brief_history WHERE project_id = ? ORDER BY version",
    )
      .bind(PROJECT)
      .all<{ version: number; content: string }>()
    // The version-1 content ("A") is snapshotted before it becomes version 2.
    expect(rows.results).toContainEqual({ version: 1, content: "A" })
  })

  it("approving a proposal whose base_version is stale → 409 conflict (with versions)", async () => {
    await seedUser(1, "lead")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, 500)
    const leadJwt = await jwtFor("lead")

    await req("PUT", `${PROJECT}/brief`, leadJwt, { content: "base v1", ifMatchVersion: 0 })
    // Agent proposes against v1.
    const prop = await req(
      "POST",
      `${PROJECT}/brief/proposals`,
      leadJwt,
      { content: "agent draft", rationale: "gap" },
      agentHeader(leadJwt),
    )
    const { proposalId } = (await prop.json()) as { proposalId: string }
    // A human edit lands FIRST → brief advances to v2.
    await req("PUT", `${PROJECT}/brief`, leadJwt, { content: "human edit v2", ifMatchVersion: 1 })

    // Approving the now-stale proposal is refused.
    const review = await req("POST", `${PROJECT}/brief/proposals/${proposalId}/review`, leadJwt, {
      action: "approve",
    })
    expect(review.status).toBe(409)
    const err = (await review.json()) as { error: { code: string; details: { baseVersion: number; currentVersion: number } } }
    expect(err.error.code).toBe("conflict")
    expect(err.error.details).toMatchObject({ baseVersion: 1, currentVersion: 2 })

    // The brief was NOT clobbered.
    const b = await req("GET", `${PROJECT}/brief`, leadJwt)
    const { brief } = (await b.json()) as { brief: { content: string } }
    expect(brief.content).toBe("human edit v2")
  })

  it("approving a proposal whose base_version is current → applies", async () => {
    await seedUser(1, "lead")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, 500)
    const leadJwt = await jwtFor("lead")

    await req("PUT", `${PROJECT}/brief`, leadJwt, { content: "base v1", ifMatchVersion: 0 })
    const prop = await req(
      "POST",
      `${PROJECT}/brief/proposals`,
      leadJwt,
      { content: "agent draft", rationale: "gap" },
      agentHeader(leadJwt),
    )
    const { proposalId } = (await prop.json()) as { proposalId: string }

    // No intervening edit → base_version still matches → approve applies.
    const review = await req("POST", `${PROJECT}/brief/proposals/${proposalId}/review`, leadJwt, {
      action: "approve",
    })
    expect(review.status).toBe(200)
    const b = await req("GET", `${PROJECT}/brief`, leadJwt)
    const { brief } = (await b.json()) as { brief: { content: string; version: number } }
    expect(brief.content).toBe("agent draft")
    expect(brief.version).toBe(2)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// buildMemoryContext (harness prompt assembly)
// ──────────────────────────────────────────────────────────────────────────

describe("buildMemoryContext", () => {
  it("indexes approved memories by path+first-line and reads detail on demand", async () => {
    await seedUser(1, "lead")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, 500)
    const leadJwt = await jwtFor("lead")

    // Set a brief.
    await req("PUT", `${PROJECT}/brief`, leadJwt, { content: "Project brief text.", ifMatchVersion: 0 })

    // One approved memory, one still-proposed (must NOT appear in the index).
    const p1 = await req("POST", `${PROJECT}/agent-memory`, leadJwt, {
      path: "glossary/grace.md",
      content: "# Grace\ngrace → gracia",
    })
    const { memoryId } = (await p1.json()) as { memoryId: string }
    await req("POST", `${PROJECT}/agent-memory/${memoryId}/review`, leadJwt, { action: "approve" })
    await req("POST", `${PROJECT}/agent-memory`, leadJwt, {
      path: "glossary/pending.md",
      content: "# Pending",
    })

    const ctx = await buildMemoryContext(env.AQUILLA_PG, PROJECT)
    expect(ctx.brief).toBe("Project brief text.")
    expect(ctx.memoryIndex).toEqual([
      { path: "glossary/grace.md", firstLine: "# Grace", humanEdited: false },
    ])
    expect(await ctx.readMemory("glossary/grace.md")).toBe("# Grace\ngrace → gracia")
    // Proposed (unapproved) memory is not readable through the context.
    expect(await ctx.readMemory("glossary/pending.md")).toBeNull()
    expect(await ctx.readMemory("does/not-exist.md")).toBeNull()
  })

  it("returns an empty brief and index for a project with no memory", async () => {
    await seedProject("empty-proj", 1)
    const ctx = await buildMemoryContext(env.AQUILLA_PG, "empty-proj")
    expect(ctx.brief).toBe("")
    expect(ctx.memoryIndex).toEqual([])
  })
})
