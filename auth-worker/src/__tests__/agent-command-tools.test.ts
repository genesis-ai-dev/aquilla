// AQU-926 (COMMAND-REGISTRY §4) — unit coverage for the registered-command
// tools: describe_command's catalog lookups and propose_command's static
// pre-validation, which must short-circuit BEFORE any sync-worker HTTP call
// (the route-level transport/error-mapping coverage lives in
// agent-route-commands.test.ts).
import { env } from "cloudflare:test"
import { describe, it, expect, afterEach, vi } from "vitest"
import {
  describeCommandTool,
  proposeCommandTool,
  type CommandToolCtx,
} from "../lib/agent/command-tools"
import type { AuthUser, Env } from "../types"
import { seedUser } from "./helpers/db"

function authUser(id: number, username: string): AuthUser {
  return {
    id,
    username,
    email: `${username}@example.com`,
    password_hash: "x",
    preferences: {},
    created_at: "",
    updated_at: "",
    password_changed_at: null,
  }
}

function ctxFor(roleLevel: number, extraEnv?: Record<string, unknown>): CommandToolCtx & {
  frames: unknown[]
} {
  const frames: unknown[] = []
  return {
    env: Object.assign(Object.create(env), extraEnv) as Env,
    runId: "run-1",
    projectId: "p1",
    roleLevel,
    user: authUser(1, "alice"),
    signal: new AbortController().signal,
    send: (frame) => frames.push(frame),
    frames,
  }
}

afterEach(() => vi.restoreAllMocks())

describe("describe_command", () => {
  it("serves the catalog paramsDoc for a known kind", () => {
    const out = describeCommandTool({ kind: "SetTranslation" }, { roleLevel: 400 })
    expect(out).toContain("### SetTranslation")
    expect(out).toContain("target.cell.commit")
  })

  it("unknown kind → error listing the kinds valid for the caller's role", () => {
    const out = describeCommandTool({ kind: "MakeCoffee" }, { roleLevel: 400 })
    expect(out).toMatch(/^error: unknown command "MakeCoffee"/)
    // CONTRIBUTOR (400) commands are listed; 500+ commands are not.
    expect(out).toContain("SetTranslation")
    expect(out).toContain("EmitEvents")
    expect(out).not.toContain("PlanImport")
  })

  it("a known kind above the caller's floor is served with a cannot-stage note", () => {
    const out = describeCommandTool({ kind: "PlanImport" }, { roleLevel: 400 })
    expect(out).toContain("note: PlanImport needs role 500+")
    expect(out).toContain("### PlanImport")
  })

  it("missing kind → usage error", () => {
    const out = describeCommandTool({}, { roleLevel: 400 })
    expect(out).toMatch(/^error: describe_command needs/)
  })
})

describe("propose_command — static pre-validation (no HTTP)", () => {
  it("rejects a kind above the run's role without calling sync-worker", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const ctx = ctxFor(400)
    const out = await proposeCommandTool(
      { commands: [{ kind: "PlanImport", fileName: "x", fileType: "usfm", cells: [] }] },
      ctx,
    )
    expect(out).toContain("PlanImport needs role 500+")
    expect(out).toContain("Commands available at your role:")
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(ctx.frames).toEqual([])
  })

  it("rejects unknown kinds with the role's available list, no HTTP", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const ctx = ctxFor(600)
    const out = await proposeCommandTool({ commands: [{ kind: "FooBar" }] }, ctx)
    expect(out).toContain('unknown kind "FooBar"')
    expect(out).toContain("PatchSettings")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("rejects a command with no string kind", async () => {
    const ctx = ctxFor(400)
    const out = await proposeCommandTool({ commands: [{ value: "hola" }] }, ctx)
    expect(out).toContain('command 1 has no string "kind"')
  })

  it("rejects an empty/missing commands array", async () => {
    const ctx = ctxFor(400)
    expect(await proposeCommandTool({}, ctx)).toMatch(/^error: propose_command needs/)
    expect(await proposeCommandTool({ commands: [] }, ctx)).toMatch(/^error: propose_command needs/)
  })

  it("reports a readable error when SYNC_WORKER_URL is unset (no mint attempted)", async () => {
    const ctx = ctxFor(400, { SYNC_WORKER_URL: undefined })
    const out = await proposeCommandTool(
      { commands: [{ kind: "SetTranslation", fileId: "f", cellId: "c", value: "v" }] },
      ctx,
    )
    expect(out).toContain("SYNC_WORKER_URL")
  })

  it("maps a mint denial to a readable authorize error (user without access)", async () => {
    // Real DB path: the project exists but alice has no grant → mint no_access.
    await seedUser(1, "alice")
    await seedUser(2, "boss")
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES ('p1', 'P', 2)").run()
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const ctx = ctxFor(400)
    const out = await proposeCommandTool(
      { commands: [{ kind: "SetTranslation", fileId: "f", cellId: "c", value: "v" }] },
      ctx,
    )
    expect(out).toContain("could not authorize staging")
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(ctx.frames).toEqual([])
  })
})
