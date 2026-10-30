// Slice 13 (Sam, Oct 28): "Should a Project lead be able to undo 'make rows
// from an audio or video file'?" — yes, narrowly. Below Maintainer a person
// may remove an IMPORTED line only by naming its creating event, when that
// event is their own `source.cell.create` of a line made from a recording
// (`medium: "media"`) and nobody else has written to the line since. Every
// other imported line still needs Maintainer (authorize-cell-editing.test.ts).
import { describe, it, expect } from "vitest"
import { authorize } from "../events/authorize"
import { makeTestToken } from "./helpers/auth"
import { ROLE } from "../events/role-policy"
import type { RawEvent } from "../events/types"
import { projectSettingsRow } from "./helpers/project-settings-db"

const SECRET = "test-secret-value-for-recording-lines"
const CREATE = "00000000-0000-7000-0000-0000000c0001"

interface Created { kind?: string; author?: string; medium?: string | null; cellId?: string }

/** cells -> an imported (not hand-added) line; events -> its creating event and what came after. */
function makeDb(opts: { created?: Created | null; someoneElseSince?: boolean; throws?: boolean }): AquillaDb {
  const { created = {}, someoneElseSince = false, throws = false } = opts
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              if (throws && sql.includes("FROM events")) throw new Error("boom")
              if (sql.includes("FROM project_settings")) return projectSettingsRow(sql, "{}")
              if (sql.includes("FROM cells")) return { metadata: { aquillaOrigin: { version: 1, kind: "import" } } }
              if (sql.includes("FROM events") && sql.includes("WHERE id = ?")) {
                if (created === null) return null
                const c = { kind: "source.cell.create", author: "alice", medium: "media", cellId: "cell-1", ...created }
                // The query is scoped to the line it names: another line's event is not found.
                if (args[3] !== c.cellId) return null
                return {
                  kind: c.kind,
                  author: c.author,
                  payload: JSON.stringify(c.medium == null ? { value: "x.mp3" } : { value: "x.mp3", medium: c.medium }),
                  server_seq: "41",
                }
              }
              if (sql.includes("FROM events") && sql.includes("author <> ?")) {
                return someoneElseSince ? { hit: 1 } : null
              }
              return null
            },
            async all() { return { results: [] } },
          }
        },
      }
    },
  } as unknown as AquillaDb
}

function del(payload: Record<string, unknown> = { undoOfEventId: CREATE }): RawEvent<"source.cell.delete"> {
  return {
    id: "00000000-0000-7000-0000-00000000de1e",
    schemaVersion: 1,
    kind: "source.cell.delete",
    projectId: "proj-a",
    fileId: "file-x",
    cellId: "cell-1",
    parentId: null,
    author: "alice",
    payload,
    clientTs: Date.now(),
  } as unknown as RawEvent<"source.cell.delete">
}

const lead = (username = "alice") =>
  makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x", role: ROLE.PROJECT_LEAD, username })

describe("undoing lines made from a recording, below Maintainer", () => {
  it("lets a Project lead take back a line she just made from a recording, untouched by anyone else", async () => {
    const result = await authorize(await lead(), del(), SECRET, makeDb({}))
    expect(result.ok).toBe(true)
  })

  it("still refuses the same delete when it names no creating event — imported lines stay Maintainer's", async () => {
    const result = await authorize(await lead(), del({}), SECRET, makeDb({}))
    expect(result).toMatchObject({ ok: false, status: 403, reason: "removing an imported cell requires maintainer" })
  })

  it("refuses once someone else has written to the line since it was made", async () => {
    const result = await authorize(await lead(), del(), SECRET, makeDb({ someoneElseSince: true }))
    expect(result).toMatchObject({ ok: false, status: 403 })
  })

  it("refuses a line somebody else made", async () => {
    const result = await authorize(await lead(), del(), SECRET, makeDb({ created: { author: "bob" } }))
    expect(result).toMatchObject({ ok: false, status: 403 })
  })

  it("refuses a line imported from a document rather than made from a recording", async () => {
    const result = await authorize(await lead(), del(), SECRET, makeDb({ created: { medium: null } }))
    expect(result).toMatchObject({ ok: false, status: 403 })
  })

  it("refuses when the named event is not a create, or belongs to another line", async () => {
    expect(await authorize(await lead(), del(), SECRET, makeDb({ created: { kind: "source.cell.commit" } })))
      .toMatchObject({ ok: false, status: 403 })
    expect(await authorize(await lead(), del(), SECRET, makeDb({ created: { cellId: "cell-2" } })))
      .toMatchObject({ ok: false, status: 403 })
    expect(await authorize(await lead(), del(), SECRET, makeDb({ created: null })))
      .toMatchObject({ ok: false, status: 403 })
  })

  it("binds the author to the token, not to the event's own author field", async () => {
    // bob signs the request but the delete claims alice wrote it: the server
    // compares the creating event with bob, so it is not his line.
    const result = await authorize(await lead("bob"), del(), SECRET, makeDb({}))
    expect(result).toMatchObject({ ok: false, status: 403 })
  })

  it("fails closed when the events cannot be read", async () => {
    const result = await authorize(await lead(), del(), SECRET, makeDb({ throws: true }))
    expect(result).toMatchObject({ ok: false, status: 403 })
  })
})
