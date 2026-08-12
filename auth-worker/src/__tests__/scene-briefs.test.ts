// Scene-brief API (contextual translation pipeline design §9). WHY: scene
// briefs are the pipeline's durable analysis product — the gate that matters is
// the same one agent-memory encodes: anyone CONTRIBUTOR+ (agent or human) may
// PROPOSE a construal, but a human PROJECT_LEAD must APPROVE it, and a
// human-edited brief can never be silently overwritten by the agent channel.
// Each test asserts a specific way that gate can fail open, not just that the
// happy path returns 200.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { pg } from "./helpers/pg-test-env"
import { PostgresDb, type PgExecutor } from "../../../db/shim/postgres"
import {
  markStale,
  getSceneBrief,
  proposeSceneBrief,
  listSceneBriefsByRun,
  SCENE_BRIEF_MAX_BYTES,
} from "../../../db/shared/scene-briefs"

const PROJECT = "proj-scene"
const RLS_MIGRATION = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../db/postgres/migrations/0034_rls_backstop.sql",
  ),
  "utf8",
)
const ACTIVITY_MIGRATION = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../db/postgres/migrations/0074_contextual_run_events.sql",
  ),
  "utf8",
)

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

describe("scene-brief run evidence", () => {
  it("passes provenance and ambiguity evidence as structured JSON at the Postgres adapter boundary", async () => {
    let adapterRegister: unknown
    let adapterProvenance: unknown
    let executor: PgExecutor
    executor = {
      async run(_sql, params) {
        adapterRegister = params[7]
        adapterProvenance = params[11]
        return {
          rows: [{
            id: params[0],
            project_id: params[1],
            file_id: params[2],
            start_cell_id: params[3],
            end_cell_id: params[4],
            target_lang: params[5],
            construal: params[6],
            ambiguity_register: params[7],
            l1_summary: params[8],
            l1_generated_at: params[9],
            l1_model_id: params[10],
            status: "proposed",
            human_edited: false,
            stale_since: null,
            stale_reason: null,
            provenance: params[11],
            created_by: params[12],
            reviewed_by: null,
            version: 1,
            created_at: "2026-08-11T00:00:00.000Z",
            updated_at: "2026-08-11T00:00:00.000Z",
          }],
          rowCount: 1,
        }
      },
      begin: (fn) => fn(executor),
    }

    const adapterDb = new PostgresDb(executor)
    const ambiguityRegister = [{ id: "a1", question: "Who is speaking?" }]
    const provenance = { runId: "run-adapter-boundary", closureRounds: 2 }
    const result = await proposeSceneBrief(adapterDb, {
      projectId: PROJECT,
      ...SPAN,
      construal: "Scene evidence.",
      ambiguityRegister,
      provenance,
    })

    expect(adapterRegister).toEqual(ambiguityRegister)
    expect(adapterProvenance).toEqual(provenance)
    expect(typeof adapterProvenance).toBe("object")
    expect(result.status).toBe("ok")
    if (result.status === "ok") expect(result.brief.provenance).toEqual(provenance)
  })

  it("migration recovers only parseable legacy provenance objects without losing other scalars", async () => {
    const insertLegacy = async (id: string, payload: string) => {
      await env.AQUILLA_PG.prepare(
        `INSERT INTO scene_briefs
            (id, project_id, file_id, start_cell_id, end_cell_id, construal, provenance)
         VALUES (?, ?, ?, ?, ?, 'Legacy scene.', to_jsonb(?::text))`,
      ).bind(id, PROJECT, SPAN.fileId, `${id}-start`, `${id}-end`, payload).run()
    }
    await insertLegacy("legacy-object", '{"runId":"legacy-run","closureRounds":2}')
    await insertLegacy("legacy-invalid", "not encoded json")
    await insertLegacy("legacy-array", '["legacy-run"]')
    await env.AQUILLA_PG.prepare(
      `INSERT INTO contextual_runs
          (id, project_id, file_id, status, role_snapshot, span_cursor)
       VALUES ('legacy-contextual-json', ?, 'legacy-contextual-file', 'terminated',
               to_jsonb('{"userId":7,"username":"legacy","level":400}'::text),
               to_jsonb('{"seeds":[],"nextIndex":0}'::text))`,
    ).bind(PROJECT).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO contextual_drafts
          (id, run_id, project_id, file_id, cell_id, text, status, verdicts, provenance)
       VALUES ('legacy-contextual-draft', 'legacy-contextual-json', ?,
               'legacy-contextual-file', 'legacy-cell', 'legacy draft', 'rejected',
               to_jsonb('{"ambiguity":"approved"}'::text),
               to_jsonb('{"spanId":"legacy-span"}'::text))`,
    ).bind(PROJECT).run()

    // Execute the exact prerequisite and activity migrations so policy/function
    // dependencies match production rather than being stubbed in the test.
    await pg.exec(RLS_MIGRATION)
    await pg.exec(ACTIVITY_MIGRATION)

    const recovered = await listSceneBriefsByRun(env.AQUILLA_PG, PROJECT, "legacy-run")
    expect(recovered.map((brief) => brief.id)).toEqual(["legacy-object"])
    const { results } = await env.AQUILLA_PG.prepare(
      `SELECT id, jsonb_typeof(provenance) AS kind, provenance
         FROM scene_briefs WHERE id LIKE 'legacy-%' ORDER BY id`,
    ).all<{ id: string; kind: string; provenance: unknown }>()
    expect(results).toEqual([
      { id: "legacy-array", kind: "string", provenance: '["legacy-run"]' },
      { id: "legacy-invalid", kind: "string", provenance: "not encoded json" },
      {
        id: "legacy-object",
        kind: "object",
        provenance: { runId: "legacy-run", closureRounds: 2 },
      },
    ])
    const normalizedContextual = await env.AQUILLA_PG.prepare(
      `SELECT jsonb_typeof(r.role_snapshot) AS role_kind,
              jsonb_typeof(r.span_cursor) AS cursor_kind,
              jsonb_typeof(d.verdicts) AS verdict_kind,
              jsonb_typeof(d.provenance) AS draft_provenance_kind,
              r.span_cursor ->> 'nextIndex' AS next_index,
              d.provenance ->> 'spanId' AS span_id
         FROM contextual_runs r
         JOIN contextual_drafts d ON d.run_id = r.id
        WHERE r.id = 'legacy-contextual-json'`,
    ).first<{
      role_kind: string
      cursor_kind: string
      verdict_kind: string
      draft_provenance_kind: string
      next_index: string
      span_id: string
    }>()
    expect(normalizedContextual).toEqual({
      role_kind: "object",
      cursor_kind: "object",
      verdict_kind: "object",
      draft_provenance_kind: "object",
      next_index: "0",
      span_id: "legacy-span",
    })
    const indexes = await pg.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE indexname IN (
          'contextual_runs_project_time',
          'contextual_runs_project_lane_time',
          'scene_briefs_run_provenance_time',
          'contextual_drafts_project_status_run_time',
          'contextual_project_leases_project_expiry'
        )
        ORDER BY indexname`,
    )
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "contextual_drafts_project_status_run_time",
      "contextual_project_leases_project_expiry",
      "contextual_runs_project_lane_time",
      "contextual_runs_project_time",
      "scene_briefs_run_provenance_time",
    ])
  })

  it("lists only the requested run/project and a bounded read keeps the latest rows", async () => {
    const base = {
      projectId: PROJECT,
      fileId: SPAN.fileId,
      startCellId: SPAN.startCellId,
      endCellId: SPAN.endCellId,
      targetLang: SPAN.targetLang,
      ambiguityRegister: [],
      provenance: { runId: "run-evidence" },
    }
    const first = await proposeSceneBrief(env.AQUILLA_PG, { ...base, construal: "First." })
    const second = await proposeSceneBrief(env.AQUILLA_PG, { ...base, construal: "Second." })
    if (first.status !== "ok" || second.status !== "ok") throw new Error("brief not proposed")
    await env.AQUILLA_PG.prepare("UPDATE scene_briefs SET created_at = '2026-01-01T00:00:00Z' WHERE id = ?")
      .bind(first.brief.id)
      .run()
    await env.AQUILLA_PG.prepare("UPDATE scene_briefs SET created_at = '2026-01-02T00:00:00Z' WHERE id = ?")
      .bind(second.brief.id)
      .run()

    expect((await listSceneBriefsByRun(env.AQUILLA_PG, PROJECT, "run-evidence", 1)).map((b) => b.id))
      .toEqual([second.brief.id])
    expect(await listSceneBriefsByRun(env.AQUILLA_PG, "other-project", "run-evidence"))
      .toEqual([])
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
