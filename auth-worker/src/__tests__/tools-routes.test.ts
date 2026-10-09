// Aquilla Tools API (prototype). Pins the contracts the SPA host relies on:
// the server repeats the save gates (a client can POST anything), install
// writes the standing grant only for declared scopes, versions bump with a
// fresh code hash, and the activity read returns exactly the tool-stamped
// writes plus the values revert needs.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { ROLE } from "../types"
import { TOOLS_API_REV } from "../../../shared/tools/manifest"
import { DEFAULT_EDITOR_MANIFEST, DEFAULT_EDITOR_SOURCE, firstPartyToolId } from "../../../shared/tools/first-party/default-editor"

const PROJECT = "proj-tools"

const GOOD_SOURCE = `<!doctype html><html><body><div id="app"></div><script>
(async () => { document.getElementById("app").textContent = "hi " + aquilla.context.project.name })()
</script></body></html>`

const MANIFEST = {
  name: "Hello tool",
  description: "says hi",
  scopes: ["read:cells", "write:target"],
  mounts: ["page"],
}

async function seedProject(): Promise<void> {
  await seedUser(1, "owner")
  await seedUser(2, "viewer")
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, ?)").bind(PROJECT, "Tools", 1).run()
  for (const [uid, role] of [[1, ROLE.OWNER], [2, ROLE.VIEWER]] as const) {
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, ?, ?)",
    ).bind(PROJECT, uid, role, 1).run()
  }
}

async function call(path: string, jwt: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  return app.request(
    `/api/v2/projects/${PROJECT}${path}`,
    {
      method: init.method ?? "GET",
      headers: { ...authHeader(jwt), "Content-Type": "application/json" },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    },
    env,
  )
}

interface ToolBody {
  tool: { id: string; currentVersion: number; codeHash: string; grantedScopes: string[]; source: string; apiRev: number }
}

describe("tools API", () => {
  it("installs a tool with a standing grant limited to declared scopes", async () => {
    await seedProject()
    const jwt = await jwtFor("owner")
    const res = await call("/tools", jwt, {
      method: "POST",
      body: { source: GOOD_SOURCE, manifest: MANIFEST, origin: "starter", grant: ["read:cells", "write:validation"] },
    })
    expect(res.status).toBe(201)
    const { tool } = (await res.json()) as ToolBody
    expect(tool.currentVersion).toBe(1)
    expect(tool.codeHash).toMatch(/^[0-9a-f]{64}$/)
    expect(tool.apiRev).toBe(TOOLS_API_REV)
    // write:validation was not declared → never granted.
    expect(tool.grantedScopes).toEqual(["read:cells"])

    const list = (await (await call("/tools", jwt)).json()) as { tools: { id: string }[] }
    expect(list.tools.map((t) => t.id)).toEqual([tool.id])
  })

  it("repeats the lint gate server-side", async () => {
    await seedProject()
    const jwt = await jwtFor("owner")
    const res = await call("/tools", jwt, {
      method: "POST",
      body: { source: `<script>fetch("https://evil.example")</script>`, manifest: MANIFEST, origin: "builder" },
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { lint: { message: string }[] } }
    expect(body.error.lint.map((l) => l.message).join(" ")).toMatch(/fetch/)
  })

  it("refuses installs below contributor", async () => {
    await seedProject()
    const jwt = await jwtFor("viewer")
    const res = await call("/tools", jwt, { method: "POST", body: { source: GOOD_SOURCE, manifest: MANIFEST, origin: "starter" } })
    expect(res.status).toBe(403)
  })

  it("adds versions with a new hash and narrows the grant to the new manifest", async () => {
    await seedProject()
    const jwt = await jwtFor("owner")
    const created = (await (await call("/tools", jwt, {
      method: "POST",
      body: { source: GOOD_SOURCE, manifest: MANIFEST, origin: "starter", grant: ["read:cells", "write:target"] },
    })).json()) as ToolBody
    const res = await call(`/tools/${created.tool.id}/versions`, jwt, {
      method: "POST",
      body: { source: GOOD_SOURCE.replace("hi ", "hello "), manifest: { ...MANIFEST, scopes: ["read:cells"] }, origin: "edit" },
    })
    expect(res.status).toBe(201)
    const { tool } = (await res.json()) as ToolBody
    expect(tool.currentVersion).toBe(2)
    expect(tool.codeHash).not.toBe(created.tool.codeHash)
    expect(tool.grantedScopes).toEqual(["read:cells"])
    const versions = (await (await call(`/tools/${tool.id}/versions`, jwt)).json()) as { versions: { version: number }[] }
    expect(versions.versions.map((v) => v.version)).toEqual([2, 1])
  })

  it("grant PUT rejects undeclared scopes and revokes", async () => {
    await seedProject()
    const jwt = await jwtFor("owner")
    const { tool } = (await (await call("/tools", jwt, {
      method: "POST",
      body: { source: GOOD_SOURCE, manifest: MANIFEST, origin: "starter", grant: ["read:cells", "write:target"] },
    })).json()) as ToolBody
    expect((await call(`/tools/${tool.id}/grant`, jwt, { method: "PUT", body: { scopes: ["read:terms"] } })).status).toBe(400)
    const ok = await call(`/tools/${tool.id}/grant`, jwt, { method: "PUT", body: { scopes: ["read:cells"] } })
    expect(await ok.json()).toEqual({ scopes: ["read:cells"] })
  })

  it("shares as an owned copy with upstream link, same hash and no grants", async () => {
    await seedProject()
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES ('proj-other', 'Other', 1)").run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-other', 1, ?, 1)",
    ).bind(ROLE.OWNER).run()
    const jwt = await jwtFor("owner")
    const { tool } = (await (await call("/tools", jwt, {
      method: "POST",
      body: { source: GOOD_SOURCE, manifest: MANIFEST, origin: "starter", grant: ["read:cells"] },
    })).json()) as ToolBody
    const res = await call(`/tools/${tool.id}/copy`, jwt, { method: "POST", body: { targetProjectId: "proj-other" } })
    expect(res.status).toBe(201)
    const copy = (await res.json()) as { tool: ToolBody["tool"] & { upstreamToolId: string; origin: string; projectId: string } }
    expect(copy.tool.projectId).toBe("proj-other")
    expect(copy.tool.upstreamToolId).toBe(tool.id)
    expect(copy.tool.origin).toBe("copy")
    expect(copy.tool.codeHash).toBe(tool.codeHash)
    expect(copy.tool.grantedScopes).toEqual([])
    // A viewer elsewhere cannot copy into a project they cannot write.
    const viewerJwt = await jwtFor("viewer")
    expect((await call(`/tools/${tool.id}/copy`, viewerJwt, { method: "POST", body: { targetProjectId: "proj-other" } })).status).toBe(403)
  })

  it("activity returns tool-stamped writes and the pre-window value", async () => {
    await seedProject()
    const jwt = await jwtFor("owner")
    const { tool } = (await (await call("/tools", jwt, {
      method: "POST",
      body: { source: GOOD_SOURCE, manifest: MANIFEST, origin: "starter" },
    })).json()) as ToolBody
    const db = env.AQUILLA_PG
    const ins = (id: string, kind: string, parent: string | null, payload: object, ts: number, prov: object | null) =>
      db.prepare(
        `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, kind, author, payload, client_ts, server_ts, parent_id, server_seq, provenance)
         VALUES (?, 1, ?, 'f1', 'c1', ?, 'owner', ?, ?, ?, ?, ?, ?::text::jsonb)`,
      ).bind(id, PROJECT, kind, JSON.stringify(payload), ts, ts, parent, ts, prov ? JSON.stringify(prov) : null).run()
    await ins("e1", "target.cell.commit", "e0", { value: "before" }, 100, null)
    const prov = { origin: "tool", toolId: tool.id, version: 1, codeHash: tool.codeHash, verified: true }
    await ins("e2", "target.cell.commit", "e1", { value: "tool text" }, 200, prov)
    await db.prepare(
      `INSERT INTO lanes (id, project_id, role, name, legacy_tag, position) VALUES ('lane-default', ?, 'target', 'Target', '', 0)`,
    ).bind(PROJECT).run()
    await db.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at, lane_id, last_editor)
       VALUES (?, 'f1', 'c1', 'target', 'tool text', 'e2', 200, 'lane-default', 'owner')`,
    ).bind(PROJECT).run()

    const res = await call(`/tools/${tool.id}/activity?since=150`, jwt)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      events: { id: string; verified: boolean }[]
      cells: { headEventId: string; priorValue: string }[]
    }
    expect(body.events.map((e) => e.id)).toEqual(["e2"])
    expect(body.events[0].verified).toBe(true)
    expect(body.cells).toEqual([expect.objectContaining({ headEventId: "e2", priorValue: "before" })])
  })
})

// apiRev 2: the first-party default editor is installed BY THE SERVER from the
// repo's source — idempotently, auto-granted once per user (a revoke sticks),
// upgraded only while pristine, and a removal is respected.
describe("first-party extensions", () => {
  interface Ensure { tool: (ToolBody["tool"] & { firstParty: string | null; origin: string }) | null; removed: boolean; created?: boolean; autoGranted: string[] }
  const ensure = async (jwt: string, key = "default-editor") => call("/tools/first-party", jwt, { method: "POST", body: { key } })

  it("installs once, auto-grants each user once, and shows up as first-party", async () => {
    await seedProject()
    const owner = await jwtFor("owner")
    const first = await ensure(owner)
    expect(first.status).toBe(201)
    const a = (await first.json()) as Ensure
    expect(a.tool?.id).toBe(await firstPartyToolId(PROJECT, "default-editor"))
    expect(a.tool?.firstParty).toBe("default-editor")
    expect(a.tool?.origin).toBe("starter")
    expect(a.tool?.source).toBe(DEFAULT_EDITOR_SOURCE)
    expect(a.autoGranted.sort()).toEqual([...DEFAULT_EDITOR_MANIFEST.scopes].sort())
    expect(a.tool?.grantedScopes.sort()).toEqual([...DEFAULT_EDITOR_MANIFEST.scopes].sort())

    const again = await ensure(owner)
    expect(again.status).toBe(200)
    const b = (await again.json()) as Ensure
    expect(b.tool?.id).toBe(a.tool?.id)
    expect(b.tool?.currentVersion).toBe(1)
    expect(b.autoGranted).toEqual([])

    // Any member may trigger it (the code is ours; writes are still authorized per event).
    const viewer = (await (await ensure(await jwtFor("viewer"))).json()) as Ensure
    expect(viewer.tool?.id).toBe(a.tool?.id)
    expect(viewer.autoGranted.length).toBeGreaterThan(0)

    const list = (await (await call("/tools", owner)).json()) as { tools: { id: string; firstParty: string | null }[] }
    expect(list.tools).toEqual([expect.objectContaining({ id: a.tool?.id, firstParty: "default-editor" })])
  })

  it("a revoke sticks, a removal stays removed, unknown keys 404", async () => {
    await seedProject()
    const owner = await jwtFor("owner")
    const { tool } = (await (await ensure(owner)).json()) as Ensure
    await call(`/tools/${tool!.id}/grant`, owner, { method: "PUT", body: { scopes: ["read:cells"] } })
    const after = (await (await ensure(owner)).json()) as Ensure
    expect(after.autoGranted).toEqual([])
    expect(after.tool?.grantedScopes).toEqual(["read:cells"])

    expect((await call(`/tools/${tool!.id}`, owner, { method: "DELETE" })).status).toBe(200)
    const removed = (await (await ensure(owner)).json()) as Ensure
    expect(removed).toMatchObject({ tool: null, removed: true })
    expect((await ensure(owner, "nope")).status).toBe(404)
  })

  it("upgrades a pristine install to the shipped code, never an edited one", async () => {
    await seedProject()
    const owner = await jwtFor("owner")
    const { tool } = (await (await ensure(owner)).json()) as Ensure
    // Simulate an older shipped build.
    await env.AQUILLA_PG.prepare("UPDATE project_tool_versions SET code_hash = ? WHERE tool_id = ?").bind("0".repeat(64), tool!.id).run()
    const upgraded = (await (await ensure(owner)).json()) as Ensure
    expect(upgraded.tool?.currentVersion).toBe(2)
    expect(upgraded.tool?.firstParty).toBe("default-editor")

    // The project changes it ("Change it" → origin edit, no firstParty mark): ours now, left alone.
    const edited = await call(`/tools/${tool!.id}/versions`, owner, {
      method: "POST",
      body: { source: DEFAULT_EDITOR_SOURCE.replace("Translate…", "Type here…"), manifest: DEFAULT_EDITOR_MANIFEST, origin: "edit" },
    })
    expect(edited.status).toBe(201)
    const kept = (await (await ensure(owner)).json()) as Ensure
    expect(kept.tool?.currentVersion).toBe(3)
    expect(kept.tool?.firstParty).toBeNull()
  })
})
