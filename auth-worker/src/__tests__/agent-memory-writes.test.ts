// AQU-AGENT §2/§3 — memory-write validation + insertion.
//
// WHY: agent-authored memory is the highest-risk write in the harness (it feeds
// future prompts). These tests freeze the guard rails contracts §3 mandates:
// path shape, size cap, secret rejection, and the invariant that an agent write
// is ALWAYS status `proposed` with provenance — never self-approved.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import {
  proposeMemory,
  proposeBriefUpdate,
  validateMemoryPath,
  validateContent,
  SECRET_PATTERNS,
  MEMORY_MAX_BYTES,
} from "../lib/agent/memory-writes"

const PROJECT = "11111111-1111-4111-8111-111111111111"

describe("memory-writes — path validation", () => {
  it("accepts lowercase slash/dash .md paths", () => {
    expect(validateMemoryPath("observations/terms.md").ok).toBe(true)
    expect(validateMemoryPath("a-b/c-d.md").ok).toBe(true)
  })
  it("rejects uppercase, spaces, traversal, and non-.md", () => {
    for (const bad of ["Notes.md", "a b.md", "../secret.md", "notes.txt", "notes"]) {
      const r = validateMemoryPath(bad)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe("validation_failed")
    }
  })
})

describe("memory-writes — content validation", () => {
  it("rejects content over the 10KB cap (bytes, not chars)", () => {
    const big = "x".repeat(MEMORY_MAX_BYTES + 1)
    expect(validateContent(big).ok).toBe(false)
  })
  it("rejects every documented secret pattern", () => {
    const samples = [
      "here is aqk_deadbeef token",
      "OPENAI key sk-abcdef",
      "-----BEGIN RSA PRIVATE KEY-----",
      "aws AKIAABCDEFGHIJKLMNOP creds",
      "password: hunter2",
    ]
    // Every sample trips at least one pattern → validateContent fails.
    for (const s of samples) {
      expect(SECRET_PATTERNS.some((re) => re.test(s))).toBe(true)
      expect(validateContent(s).ok).toBe(false)
    }
  })
  it("accepts ordinary prose", () => {
    expect(validateContent("The term 'grace' is rendered as X in this project.").ok).toBe(true)
  })
})

describe("memory-writes — proposeMemory insertion", () => {
  it("inserts a proposed row with provenance and returns its id", async () => {
    const res = await proposeMemory(env.AQUILLA_PG, {
      projectId: PROJECT,
      path: "observations/terms.md",
      content: "Render 'covenant' consistently.",
      rationale: "seen 3x in review",
      createdBy: "alice",
      provenance: { runId: "run-1", sessionId: "sess-1" },
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.status).toBe("proposed")

    const row = await env.AQUILLA_PG.prepare(
      "SELECT status, created_by, provenance::text AS provenance FROM agent_memories WHERE id = ?",
    )
      .bind(res.memoryId)
      .first<{ status: string; created_by: string; provenance: string }>()
    expect(row?.status).toBe("proposed")
    expect(row?.created_by).toBe("alice")
    expect(JSON.parse(row!.provenance)).toEqual({ runId: "run-1", sessionId: "sess-1" })
  })

  it("rejects a secret before touching the DB", async () => {
    const res = await proposeMemory(env.AQUILLA_PG, {
      projectId: PROJECT,
      path: "observations/leak.md",
      content: "token aqk_supersecret",
      rationale: "x",
      createdBy: "alice",
      provenance: { runId: "run-1" },
    })
    expect(res.ok).toBe(false)
    const { results } = await env.AQUILLA_PG.prepare(
      "SELECT id FROM agent_memories WHERE path = ?",
    )
      .bind("observations/leak.md")
      .all()
    expect(results.length).toBe(0)
  })
})

describe("memory-writes — proposeBriefUpdate insertion", () => {
  it("inserts a proposed brief proposal", async () => {
    const res = await proposeBriefUpdate(env.AQUILLA_PG, {
      projectId: PROJECT,
      content: "This project targets a formal register.",
      rationale: "clarified with the team",
      createdBy: "alice",
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const row = await env.AQUILLA_PG.prepare(
      "SELECT status FROM project_brief_proposals WHERE id = ?",
    )
      .bind(res.proposalId)
      .first<{ status: string }>()
    expect(row?.status).toBe("proposed")
  })
  it("rejects a secret in the brief content", async () => {
    const res = await proposeBriefUpdate(env.AQUILLA_PG, {
      projectId: PROJECT,
      content: "password=hunter2",
      rationale: "x",
      createdBy: "alice",
    })
    expect(res.ok).toBe(false)
  })
})
