// AQU-460 — the Bible Aquifer gate's derive-on-read logic.
//
// WHY: the prior design persisted `bibleResourcesEnabled` via a client
// load-time effect, which silently re-enabled an explicit OFF (a trust bug).
// The redesign never writes anything — `isBibleResourcesEnabled` DERIVES the
// effective value at read time: explicit override wins when set; otherwise
// scripture-file presence decides. These tests exercise the full matrix
// directly against `isBibleResourcesEnabled`, independent of the HTTP layer
// (aquifer-routes.test.ts covers the route-level 404/200 behavior).

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { isBibleResourcesEnabled } from "../lib/aquifer/gate"
import { seedUser } from "./helpers/db"

async function seedProject(id: string): Promise<void> {
  await seedUser(1, `owner_${id}`)
  await env.AQUILLA_PG.prepare(`INSERT INTO projects (id, name, created_by) VALUES (?, 'P', 1)`)
    .bind(id)
    .run()
}

async function seedFile(projectId: string, fileId: string, kind: string | null): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO files (id, project_id, name, kind, event_id, cell_count, approved_count, word_count, last_edit_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, 0, NULL)`,
  )
    .bind(fileId, projectId, fileId, kind, `evt-${fileId}`)
    .run()
}

async function seedExplicitSetting(projectId: string, value: boolean): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES (?, ?, 1, 1)`,
  )
    .bind(projectId, JSON.stringify({ bibleResourcesEnabled: value }))
    .run()
}

let counter = 0
function freshProjectId(): string {
  counter += 1
  return `11111111-1111-4111-8${String(counter).padStart(3, "0")}-111111111111`
}

describe("isBibleResourcesEnabled — AQU-460 derive-on-read matrix", () => {
  it("unset + scripture file (usfm) -> true (derived default-on)", async () => {
    const p = freshProjectId()
    await seedProject(p)
    await seedFile(p, "f1", "usfm")
    expect(await isBibleResourcesEnabled(env, p)).toBe(true)
  })

  it("unset + scripture file (ebible) -> true", async () => {
    const p = freshProjectId()
    await seedProject(p)
    await seedFile(p, "f1", "ebible")
    expect(await isBibleResourcesEnabled(env, p)).toBe(true)
  })

  it("unset + scripture file (helloao) -> true", async () => {
    const p = freshProjectId()
    await seedProject(p)
    await seedFile(p, "f1", "helloao")
    expect(await isBibleResourcesEnabled(env, p)).toBe(true)
  })

  it("unset + non-scripture file only -> false", async () => {
    const p = freshProjectId()
    await seedProject(p)
    await seedFile(p, "f1", "docx")
    expect(await isBibleResourcesEnabled(env, p)).toBe(false)
  })

  it("unset + no files at all -> false", async () => {
    const p = freshProjectId()
    await seedProject(p)
    expect(await isBibleResourcesEnabled(env, p)).toBe(false)
  })

  it("explicit true, no scripture files -> true (explicit override wins)", async () => {
    const p = freshProjectId()
    await seedProject(p)
    await seedFile(p, "f1", "docx")
    await seedExplicitSetting(p, true)
    expect(await isBibleResourcesEnabled(env, p)).toBe(true)
  })

  it("explicit false, HAS scripture files -> false (the trust invariant: explicit OFF always respected)", async () => {
    const p = freshProjectId()
    await seedProject(p)
    await seedFile(p, "f1", "usfm")
    await seedExplicitSetting(p, false)
    expect(await isBibleResourcesEnabled(env, p)).toBe(false)
  })

  it("scripture file that is soft-deleted (deleted_at set) does not count toward derivation", async () => {
    const p = freshProjectId()
    await seedProject(p)
    await seedFile(p, "f1", "usfm")
    await env.AQUILLA_PG.prepare(`UPDATE files SET deleted_at = 1 WHERE id = 'f1'`).run()
    expect(await isBibleResourcesEnabled(env, p)).toBe(false)
  })
})
