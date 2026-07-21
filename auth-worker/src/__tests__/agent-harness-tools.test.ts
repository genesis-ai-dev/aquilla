// AQU-AGENT §2 — harness tool handlers (sandbox / import / memory) + the
// untrusted-content guard.
//
// WHY: these tools are the agent's new hands. The tests freeze the contracts §2
// behaviours a UI + safety review depend on: sandbox-unavailable is a CLEAN
// tool error (not a thrown run), touching artifact bytes LOCKS memory writes for
// the turn, plan_import refuses to silently chunk oversized files, and every
// tool emits the exact §4 frame shape.
import { env } from "cloudflare:test"
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest"
import { seedUser } from "./helpers/db"
import { ensureAgentMemoryTables } from "./helpers/agent-memory-schema"
import type { HarnessFrame } from "../lib/agent/frames"
import type { MemoryContext } from "../../../db/shared/agent-memory"
import {
  runCode,
  loadArtifact,
  readSandboxFile,
  planImport,
  proposeMemoryTool,
  readMemoryTool,
  type HarnessToolCtx,
  PLAN_IMPORT_MAX_CELLS,
} from "../lib/agent/harness-tools"

const PROJECT = "11111111-1111-4111-8111-111111111111"

interface Harness {
  ctx: HarnessToolCtx
  frames: HarnessFrame[]
  guard: { active: boolean; usedThisTurn: boolean }
  registered: { credentialId: string }[]
}

function makeHarness(overrides?: {
  sandbox?: boolean
  memory?: Partial<MemoryContext>
}): Harness {
  const frames: HarnessFrame[] = []
  const guard = { active: false, usedThisTurn: false }
  const registered: { credentialId: string }[] = []
  const memory: MemoryContext = {
    brief: overrides?.memory?.brief ?? "",
    memoryIndex: overrides?.memory?.memoryIndex ?? [],
    readMemory: overrides?.memory?.readMemory ?? (async () => null),
  }
  const sandboxOn = overrides?.sandbox ?? false
  const ctx: HarnessToolCtx = {
    env: {
      AQUILLA_PG: env.AQUILLA_PG,
      SYNC_WORKER_URL: "https://api.aquilla.app/sync",
      AGENT_SANDBOX_URL: sandboxOn ? "http://127.0.0.1:8790" : undefined,
      AGENT_SANDBOX_KEY: sandboxOn ? "dev-sandbox-key" : undefined,
    },
    runId: "run-1",
    sandboxSessionId: "sess-1",
    sessionId: "sess-1",
    projectId: PROJECT,
    userId: 1,
    username: "alice",
    signal: new AbortController().signal,
    send: (f) => frames.push(f),
    memory,
    markUntrusted: () => {
      guard.active = true
      guard.usedThisTurn = true
    },
    isUntrustedActive: () => guard.active,
    registerCredential: (c) => registered.push(c),
  }
  return { ctx, frames, guard, registered }
}

beforeAll(async () => {
  await ensureAgentMemoryTables()
})

afterEach(() => vi.restoreAllMocks())

describe("run_code", () => {
  it("returns a clear 'sandbox unavailable' error when unconfigured, and still marks untrusted", async () => {
    const h = makeHarness({ sandbox: false })
    const text = await runCode({ language: "python", code: "print(1)" }, h.ctx)
    expect(text).toContain("sandbox unavailable")
    expect(h.guard.active).toBe(true) // untrusted flag set even on failure
    // A code.start + code.output pair still frames the UI block.
    expect(h.frames.map((f) => f.type)).toEqual(["tool.code.start", "tool.code.output"])
  })

  it("executes and emits tool.code.start/output with the sandbox result", async () => {
    const h = makeHarness({ sandbox: true })
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, stdout: "hello", stderr: "", durationMs: 12, truncated: false }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )
    const text = await runCode({ language: "js", code: "console.log('hi')" }, h.ctx)
    expect(text).toContain("stdout:\nhello")
    const start = h.frames.find((f) => f.type === "tool.code.start")
    expect(start).toMatchObject({ type: "tool.code.start", language: "js", codePreview: "console.log('hi')" })
    const out = h.frames.find((f) => f.type === "tool.code.output")
    expect(out).toMatchObject({ type: "tool.code.output", stdout: "hello", durationMs: 12 })
  })
})

describe("load_artifact", () => {
  it("404s a missing artifact and marks untrusted", async () => {
    const h = makeHarness({ sandbox: true })
    const text = await loadArtifact({ artifactId: "00000000-0000-4000-8000-000000000000", path: "/workspace/x" }, h.ctx)
    expect(text).toContain("not found")
    expect(h.guard.active).toBe(true)
  })

  it("resolves the R2 key and copies bytes into the sandbox", async () => {
    const h = makeHarness({ sandbox: true })
    const artifactId = "22222222-2222-4222-8222-222222222222"
    await env.AQUILLA_PG.prepare(
      `INSERT INTO artifacts (id, project_id, uploaded_by_user_id, credential_id, name, size_bytes, sha256, r2_key)
       VALUES (?, ?, '1', 'cred', 'genesis.usfm', 10, 'abc', 'artifacts/p/a')`,
    )
      .bind(artifactId, PROJECT)
      .run()
    let fetchedBody: Record<string, unknown> | null = null
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      fetchedBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ ok: true, bytes: 10 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    })
    const text = await loadArtifact({ artifactId, path: "/workspace/genesis.usfm" }, h.ctx)
    expect(text).toContain("10 bytes")
    expect(fetchedBody).toEqual({ key: "artifacts/p/a", path: "/workspace/genesis.usfm" })
  })
})

describe("read_sandbox_file", () => {
  it("returns decoded text from the sandbox", async () => {
    const h = makeHarness({ sandbox: true })
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new TextEncoder().encode("file contents"), { status: 200 }),
    )
    const text = await readSandboxFile({ path: "/workspace/out.txt" }, h.ctx)
    expect(text).toBe("file contents")
  })
})

describe("plan_import", () => {
  it("refuses to silently chunk an oversized file", async () => {
    const h = makeHarness()
    const cells = Array.from({ length: PLAN_IMPORT_MAX_CELLS + 1 }, (_, i) => ({ original: `c${i}` }))
    const text = await planImport({ fileName: "big.usfm", fileType: "usfm", cells }, h.ctx)
    expect(text).toContain("split this into multiple smaller files")
  })

  it("stages a changeset, emits changeset.staged, and registers the credential", async () => {
    await seedUser(1, "alice")
    const h = makeHarness()
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          changeset: { id: "cs-9" },
          summary: { sourceCellsAdded: 1, warnings: [] },
          approvalUrl: "https://aquilla.app/approve/cs-9",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )
    const text = await planImport(
      { fileName: "genesis.usfm", fileType: "usfm", cells: [{ original: "In the beginning" }] },
      h.ctx,
    )
    expect(text).toContain("cs-9")
    const frame = h.frames.find((f) => f.type === "changeset.staged")
    expect(frame).toMatchObject({ type: "changeset.staged", changesetId: "cs-9", cellCount: 1 })
    expect(h.registered).toHaveLength(1)
  })
})

describe("untrusted-content guard", () => {
  it("blocks propose_memory once run_code has touched artifact bytes this turn", async () => {
    const h = makeHarness({ sandbox: false })
    // run_code marks untrusted (even the unavailable path sets the flag).
    await runCode({ language: "python", code: "x=1" }, h.ctx)
    const text = await proposeMemoryTool(
      { path: "observations/x.md", content: "note", rationale: "why" },
      h.ctx,
    )
    expect(text).toContain("memory writes disabled while processing untrusted content")
    // No memory.proposed frame emitted.
    expect(h.frames.some((f) => f.type === "memory.proposed")).toBe(false)
  })

  it("allows propose_memory on a clean turn and emits memory.proposed", async () => {
    await seedUser(1, "alice")
    const h = makeHarness()
    const text = await proposeMemoryTool(
      { path: "observations/terms.md", content: "Render covenant consistently.", rationale: "3x" },
      h.ctx,
    )
    expect(text).toContain("proposed memory")
    const frame = h.frames.find((f) => f.type === "memory.proposed")
    expect(frame).toMatchObject({ type: "memory.proposed", path: "observations/terms.md" })
  })
})

describe("read_memory", () => {
  it("returns the index without a path and full content with one", async () => {
    const h = makeHarness({
      memory: {
        memoryIndex: [{ path: "observations/terms.md", firstLine: "Render covenant" }],
        readMemory: async (p) => (p === "observations/terms.md" ? "full content here" : null),
      },
    })
    expect(await readMemoryTool({}, h.ctx)).toContain("observations/terms.md")
    expect(await readMemoryTool({ path: "observations/terms.md" }, h.ctx)).toBe("full content here")
    expect(await readMemoryTool({ path: "missing.md" }, h.ctx)).toContain("no approved memory")
  })
})
