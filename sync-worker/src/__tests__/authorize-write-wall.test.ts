import { describe, expect, it } from "vitest"
import { authorize } from "../events/authorize"
import { makeTestToken } from "./helpers/auth"
import { makeTestDb } from "./helpers/pg-test-db"
import type { RawEvent } from "../events/types"
import type { SyncTokenClaims } from "../auth"

const SECRET = "write-wall-secret"
const PROJECT = "proj-write"
const FILE = "file-write"
const ES = "lane-es"
const FR = "lane-fr"

function commit(targetLang: string): RawEvent<"target.cell.commit"> {
  return {
    id: "00000000-0000-7000-0000-0000000000a1",
    schemaVersion: 1,
    kind: "target.cell.commit",
    projectId: PROJECT,
    fileId: FILE,
    cellId: "cell-1",
    parentId: "00000000-0000-7000-0000-000000000000",
    author: "alice",
    payload: { value: "hola", valueHtml: "<p>hola</p>", targetLang },
    clientTs: Date.now(),
  }
}

async function db() {
  const { db } = await makeTestDb({
    lanes: [
      { id: ES, project_id: PROJECT, role: "target", name: "Spanish", lang_code: "es", legacy_tag: "es" },
      { id: FR, project_id: PROJECT, role: "target", name: "French", lang_code: "fr", legacy_tag: "fr" },
    ],
  })
  return db
}

async function token(partial: Partial<SyncTokenClaims> = {}) {
  return makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE, role: 400, ...partial })
}

describe("AQU-1415 write wall", () => {
  it("keeps the additive scopes path when the flag is unset", async () => {
    const res = await authorize(await token(), commit("es"), SECRET, await db(), undefined, undefined)
    expect(res.ok).toBe(true)
  })

  it("denies a contributor with no grant and allows the granted lane only", async () => {
    const database = await db()
    const denied = await authorize(
      await token(),
      commit("es"),
      SECRET,
      database,
      undefined,
      "1",
    )
    expect(denied).toMatchObject({ ok: false, status: 403 })

    const allowed = await authorize(
      await token({ laneGrants: [{ lane: ES, level: 400 }] }),
      commit("es"),
      SECRET,
      database,
      undefined,
      "1",
    )
    expect(allowed.ok).toBe(true)

    const sibling = await authorize(
      await token({ laneGrants: [{ lane: ES, level: 400 }] }),
      commit("fr"),
      SECRET,
      database,
      undefined,
      "1",
    )
    expect(sibling).toMatchObject({ ok: false, status: 403 })
  })

  it("lets a maintainer write every lane without a grant", async () => {
    const res = await authorize(
      await token({ role: 600 }),
      commit("fr"),
      SECRET,
      await db(),
      undefined,
      "1",
    )
    expect(res.ok).toBe(true)
  })

  it("elevates a commenter only inside the granted lane", async () => {
    const database = await db()
    const elevated = await authorize(
      await token({ role: 200, laneGrants: [{ lane: ES, level: 400 }] }),
      commit("es"),
      SECRET,
      database,
      undefined,
      "1",
    )
    expect(elevated.ok).toBe(true)

    const other = await authorize(
      await token({ role: 200, laneGrants: [{ lane: ES, level: 400 }] }),
      commit("fr"),
      SECRET,
      database,
      undefined,
      "1",
    )
    expect(other.ok).toBe(false)
  })

  it("still enforces file scopes while the wall is on", async () => {
    const res = await authorize(
      await token({
        laneGrants: [{ lane: ES, level: 400 }],
        scopes: [{ kind: "file", value: "other-file" }],
      }),
      commit("es"),
      SECRET,
      await db(),
      undefined,
      "1",
    )
    expect(res).toMatchObject({ ok: false, status: 403 })
  })
})
