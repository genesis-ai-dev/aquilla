// Scene-brief API (contextual translation pipeline design §9). WHY: scene
// briefs are the pipeline's durable analysis product — the gate that matters is
// the same one agent-memory encodes: anyone CONTRIBUTOR+ (agent or human) may
// PROPOSE a construal, but a human PROJECT_LEAD must APPROVE it, and a
// human-edited brief can never be silently overwritten by the agent channel.
// Each test asserts a specific way that gate can fail open, not just that the
// happy path returns 200.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import {
  markStale,
  getSceneBrief,
  SCENE_BRIEF_MAX_BYTES,
} from "../../../db/shared/scene-briefs"

const PROJECT = "proj-scene"

// The span every test proposes against unless it says otherwise.
const SPAN = {
  fileId: "file-luk",
  startCellId: "cell-0001",
  endCellId: "cell-0008",
  targetLang: "es",
}

async function seedProject(projectId: string, createdBy: number): Promise<void> {
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, ?)")
    .bind(projectId, "Scene Project", createdBy)
    .run()
}

async function grant(projectId: string, userId: number, role: number): Promise<void> {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, ?, ?)",
  )
    .bind(projectId, userId, role, userId)
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

/** Propose a brief on SPAN as `jwt`; returns the new brief id. */
async function propose(jwt: string, construal = "Scene: Zechariah in the temple."): Promise<string> {
  const r = await req("POST", `${PROJECT}/scene-briefs`, jwt, { ...SPAN, construal })
  expect(r.status).toBe(201)
  const { sceneBriefId } = (await r.json()) as { sceneBriefId: string }
  return sceneBriefId
}

// ──────────────────────────────────────────────────────────────────────────
// Propose → approve lifecycle + supersede on the span key
// ──────────────────────────────────────────────────────────────────────────

describe("scene-brief propose → review lifecycle", () => {
  it("contributor proposes, lead approves, a second approval archives the first (span key)", async () => {
    await seedUser(1, "lead")
    await seedUser(2, "contrib")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, 500) // project_lead
    await grant(PROJECT, 2, 400) // contributor
    const leadJwt = await jwtFor("lead")
    const contribJwt = await jwtFor("contrib")

    const id1 = await propose(contribJwt, "Construal v1.")
    const a1 = await req("POST", `${PROJECT}/scene-briefs/${id1}/review`, leadJwt, {
      action: "approve",
    })
    expect(a1.status).toBe(200)
    const approved1 = (await a1.json()) as { sceneBrief: { status: string } }
    expect(approved1.sceneBrief.status).toBe("approved")

    // A second proposal on the SAME span key, approved → supersedes the first.
    const id2 = await propose(contribJwt, "Construal v2 — revised.")
    const a2 = await req("POST", `${PROJECT}/scene-briefs/${id2}/review`, leadJwt, {
      action: "approve",
    })
    expect(a2.status).toBe(200)

    // Old row archived, new row approved — the partial unique index held.
    const list = await req("GET", `${PROJECT}/scene-briefs?fileId=${SPAN.fileId}`, leadJwt)
    const { sceneBriefs } = (await list.json()) as {
      sceneBriefs: Array<{ id: string; status: string }>
    }
    const byId = Object.fromEntries(sceneBriefs.map((b) => [b.id, b.status]))
    expect(byId[id1]).toBe("archived")
    expect(byId[id2]).toBe("approved")
  })

  it("a differing target_lang is a DIFFERENT span key — both approvals stand", async () => {
    await seedUser(1, "lead")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, 500)
    const leadJwt = await jwtFor("lead")

    const id1 = await propose(leadJwt)
    const r2 = await req("POST", `${PROJECT}/scene-briefs`, leadJwt, {
      ...SPAN,
      targetLang: "fr",
      construal: "Construal for French.",
    })
    const { sceneBriefId: id2 } = (await r2.json()) as { sceneBriefId: string }
    await req("POST", `${PROJECT}/scene-briefs/${id1}/review`, leadJwt, { action: "approve" })
    await req("POST", `${PROJECT}/scene-briefs/${id2}/review`, leadJwt, { action: "approve" })

    const list = await req("GET", `${PROJECT}/scene-briefs?status=approved`, leadJwt)
    const { sceneBriefs } = (await list.json()) as { sceneBriefs: Array<{ id: string }> }
    expect(sceneBriefs.map((b) => b.id).sort()).toEqual([id1, id2].sort())
  })

  it("rejects a proposal without archiving anything; re-review → 409", async () => {
    await seedUser(1, "lead")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, 500)
    const leadJwt = await jwtFor("lead")

    const id = await propose(leadJwt)
    const r = await req("POST", `${PROJECT}/scene-briefs/${id}/review`, leadJwt, {
      action: "reject",
    })
    expect(r.status).toBe(200)
    const { sceneBrief } = (await r.json()) as { sceneBrief: { status: string } }
    expect(sceneBrief.status).toBe("rejected")

    // Only proposed briefs can be reviewed.
    const again = await req("POST", `${PROJECT}/scene-briefs/${id}/review`, leadJwt, {
      action: "approve",
    })
    expect(again.status).toBe(409)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// PATCH — optimistic concurrency + human-edit semantics
// ──────────────────────────────────────────────────────────────────────────

describe("scene-brief PATCH", () => {
  it("human PATCH sets human_edited=true, bumps version; stale ifMatchVersion → 409", async () => {
    await seedUser(1, "lead")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, 500)
    const leadJwt = await jwtFor("lead")
    const id = await propose(leadJwt)

    const patch = await req("PATCH", `${PROJECT}/scene-briefs/${id}`, leadJwt, {
      ifMatchVersion: 1,
      construal: "Human-refined construal.",
    })
    expect(patch.status).toBe(200)
    const { sceneBrief } = (await patch.json()) as {
      sceneBrief: { humanEdited: boolean; version: number; construal: string }
    }
    expect(sceneBrief.humanEdited).toBe(true)
    expect(sceneBrief.version).toBe(2)
    expect(sceneBrief.construal).toBe("Human-refined construal.")

    // Replaying against the superseded version → per-row 409 with the current
    // version so the client can reload just this scene.
    const stale = await req("PATCH", `${PROJECT}/scene-briefs/${id}`, leadJwt, {
      ifMatchVersion: 1,
      construal: "clobber",
    })
    expect(stale.status).toBe(409)
    const err = (await stale.json()) as {
      error: { code: string; details: { currentVersion: number } }
    }
    expect(err.error.code).toBe("conflict")
    expect(err.error.details.currentVersion).toBe(2)
  })

  it("agent-channel PATCH on a non-human-edited row → 403 agent_edit_forbidden", async () => {
    await seedUser(1, "lead")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, 500)
    const leadJwt = await jwtFor("lead")
    const id = await propose(leadJwt)

    const agentPatch = await req(
      "PATCH",
      `${PROJECT}/scene-briefs/${id}`,
      leadJwt,
      { ifMatchVersion: 1, construal: "agent overwrite" },
      agentHeader(leadJwt),
    )
    expect(agentPatch.status).toBe(403)
    const err = (await agentPatch.json()) as { error: { code: string } }
    expect(err.error.code).toBe("agent_edit_forbidden")
  })

  it("agent-channel PATCH on a human_edited row → 403 human_edit_protected", async () => {
    await seedUser(1, "lead")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, 500)
    const leadJwt = await jwtFor("lead")
    const id = await propose(leadJwt)
    // Human edits first → human_edited=true.
    await req("PATCH", `${PROJECT}/scene-briefs/${id}`, leadJwt, {
      ifMatchVersion: 1,
      construal: "human word",
    })

    const agentPatch = await req(
      "PATCH",
      `${PROJECT}/scene-briefs/${id}`,
      leadJwt,
      { ifMatchVersion: 2, construal: "agent overwrite" },
      agentHeader(leadJwt),
    )
    expect(agentPatch.status).toBe(403)
    const err = (await agentPatch.json()) as { error: { code: string } }
    expect(err.error.code).toBe("human_edit_protected")
  })

  it("contributor may PATCH own proposal but not someone else's", async () => {
    await seedUser(1, "lead")
    await seedUser(2, "contrib")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, 500)
    await grant(PROJECT, 2, 400)
    const leadJwt = await jwtFor("lead")
    const contribJwt = await jwtFor("contrib")

    const ownId = await propose(contribJwt, "Contributor's own construal.")
    const own = await req("PATCH", `${PROJECT}/scene-briefs/${ownId}`, contribJwt, {
      ifMatchVersion: 1,
      construal: "refined by author",
    })
    expect(own.status).toBe(200)

    const leadsId = await req("POST", `${PROJECT}/scene-briefs`, leadJwt, {
      ...SPAN,
      startCellId: "cell-0009",
      endCellId: "cell-0016",
      construal: "Lead's construal.",
    })
    const { sceneBriefId } = (await leadsId.json()) as { sceneBriefId: string }
    const other = await req("PATCH", `${PROJECT}/scene-briefs/${sceneBriefId}`, contribJwt, {
      ifMatchVersion: 1,
      construal: "not mine",
    })
    expect(other.status).toBe(403)
    const err = (await other.json()) as { error: { code: string } }
    expect(err.error.code).toBe("permission_denied")
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Validation — byte cap + secret scan (mirrored from agent memory)
// ──────────────────────────────────────────────────────────────────────────

describe("scene-brief content validation", () => {
  it("rejects a construal over the 10KB row cap", async () => {
    await seedUser(1, "lead")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, 500)
    const leadJwt = await jwtFor("lead")

    const r = await req("POST", `${PROJECT}/scene-briefs`, leadJwt, {
      ...SPAN,
      construal: "x".repeat(SCENE_BRIEF_MAX_BYTES + 1),
    })
    expect(r.status).toBe(400)
    const err = (await r.json()) as { error: { code: string; message: string } }
    expect(err.error.code).toBe("validation_failed")
    expect(err.error.message).toContain("byte limit")
  })

  it("rejects content matching a secret pattern in any text-bearing field", async () => {
    await seedUser(1, "lead")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, 500)
    const leadJwt = await jwtFor("lead")

    // Construal carries the secret.
    for (const construal of ["token=aqk_abc123", "key sk-live-xyz", "password: hunter2"]) {
      const r = await req("POST", `${PROJECT}/scene-briefs`, leadJwt, { ...SPAN, construal })
      expect(r.status).toBe(400)
      const err = (await r.json()) as { error: { code: string } }
      expect(err.error.code).toBe("validation_failed")
    }
    // Ambiguity-register text is scanned too.
    const viaRegister = await req("POST", `${PROJECT}/scene-briefs`, leadJwt, {
      ...SPAN,
      construal: "clean",
      ambiguityRegister: [{ id: "a1", question: "is AKIAABCDEFGHIJKLMNOP a name?" }],
    })
    expect(viaRegister.status).toBe(400)
  })

  it("PATCH re-validates: injecting a secret via edit → 400", async () => {
    await seedUser(1, "lead")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, 500)
    const leadJwt = await jwtFor("lead")
    const id = await propose(leadJwt)

    const r = await req("PATCH", `${PROJECT}/scene-briefs/${id}`, leadJwt, {
      ifMatchVersion: 1,
      construal: "-----BEGIN RSA",
    })
    expect(r.status).toBe(400)
    const err = (await r.json()) as { error: { code: string } }
    expect(err.error.code).toBe("validation_failed")
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Role floors + agent-channel review gate
// ──────────────────────────────────────────────────────────────────────────

describe("scene-brief role floors", () => {
  it("propose requires contributor (viewer → 403); review requires lead (contributor → 403)", async () => {
    await seedUser(1, "lead")
    await seedUser(2, "contrib")
    await seedUser(3, "viewer")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, 500)
    await grant(PROJECT, 2, 400)
    await grant(PROJECT, 3, 100)
    const contribJwt = await jwtFor("contrib")
    const viewerJwt = await jwtFor("viewer")

    const denied = await req("POST", `${PROJECT}/scene-briefs`, viewerJwt, {
      ...SPAN,
      construal: "viewer cannot",
    })
    expect(denied.status).toBe(403)

    const id = await propose(contribJwt)
    const review = await req("POST", `${PROJECT}/scene-briefs/${id}/review`, contribJwt, {
      action: "approve",
    })
    expect(review.status).toBe(403)
    const err = (await review.json()) as { error: { code: string } }
    expect(err.error.code).toBe("permission_denied")

    // Viewer CAN list.
    const list = await req("GET", `${PROJECT}/scene-briefs`, viewerJwt)
    expect(list.status).toBe(200)
  })

  it("non-member cannot list; agent-channel review → 403 agent_review_denied", async () => {
    await seedUser(1, "lead")
    await seedUser(4, "outsider")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, 500)
    const leadJwt = await jwtFor("lead")
    const outsiderJwt = await jwtFor("outsider")

    const list = await req("GET", `${PROJECT}/scene-briefs`, outsiderJwt)
    expect(list.status).toBe(403)

    // Even a lead JWT on the agent channel may not review — human-only gate.
    const id = await propose(leadJwt)
    const r = await req(
      "POST",
      `${PROJECT}/scene-briefs/${id}/review`,
      leadJwt,
      { action: "approve" },
      agentHeader(leadJwt),
    )
    expect(r.status).toBe(403)
    const err = (await r.json()) as { error: { code: string } }
    expect(err.error.code).toBe("agent_review_denied")
  })
})

// ──────────────────────────────────────────────────────────────────────────
// markStale (shared primitive, consumed by the pipeline's event hook)
// ──────────────────────────────────────────────────────────────────────────

describe("markStale", () => {
  it("stamps stale_since once, refreshes the reason, and never bumps version", async () => {
    await seedUser(1, "lead")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, 500)
    const leadJwt = await jwtFor("lead")
    const id = await propose(leadJwt)

    const first = await markStale(env.AQUILLA_PG, id, "source-edit")
    expect(first.status).toBe("ok")
    if (first.status !== "ok") return
    expect(first.brief.staleSince).not.toBeNull()
    expect(first.brief.staleReason).toBe("source-edit")
    expect(first.brief.version).toBe(1)

    // Idempotent marker: stale_since is preserved (oldest-first maintenance
    // ordering depends on it), only the reason updates.
    const second = await markStale(env.AQUILLA_PG, id, "neighbor-change")
    expect(second.status).toBe("ok")
    if (second.status !== "ok") return
    expect(second.brief.staleSince).toBe(first.brief.staleSince)
    expect(second.brief.staleReason).toBe("neighbor-change")

    // Unknown id → not_found.
    expect((await markStale(env.AQUILLA_PG, "no-such-id", "source-edit")).status).toBe("not_found")
  })

  it("human PATCH clears staleness — the human just re-authored the content", async () => {
    await seedUser(1, "lead")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 1, 500)
    const leadJwt = await jwtFor("lead")
    const id = await propose(leadJwt)
    await markStale(env.AQUILLA_PG, id, "source-edit")

    const patch = await req("PATCH", `${PROJECT}/scene-briefs/${id}`, leadJwt, {
      ifMatchVersion: 1,
      construal: "re-authored after the source change",
    })
    expect(patch.status).toBe(200)
    const fresh = await getSceneBrief(env.AQUILLA_PG, id)
    expect(fresh?.staleSince).toBeNull()
    expect(fresh?.staleReason).toBeNull()
  })
})
