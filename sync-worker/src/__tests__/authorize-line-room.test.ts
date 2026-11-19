// AQU-2432 (review, Nov 9): an unrecorded line's ROOM rides `cell.lane.retime`
// and is written to that line's source row in the file the event names. Aimed
// at the wrong file (the open file instead of the cue file that holds a heard
// line) it changed no row and said nothing, so the drag was silently lost. The
// perimeter now refuses it, so the client hears about it.
import { describe, it, expect } from "vitest"
import { authorize } from "../events/authorize"
import { makeTestToken } from "./helpers/auth"
import { ROLE } from "../events/role-policy"
import type { RawEvent } from "../events/types"

const SECRET = "test-secret-value-for-line-room"

/** `cells` answers which file the line lives in (null: no such line). */
function makeDb(lineFileId: string | null): AquillaDb & { cellReads: number } {
  const db = {
    cellReads: 0,
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async first() {
              if (sql.includes("SELECT file_id FROM cells")) {
                db.cellReads += 1
                return lineFileId ? { file_id: lineFileId } : null
              }
              return null
            },
            async all() { return { results: [] } },
          }
        },
      }
    },
  }
  return db as unknown as AquillaDb & { cellReads: number }
}

function retime(payload: Record<string, unknown>): RawEvent<"cell.lane.retime"> {
  return {
    id: "00000000-0000-7000-0000-00000000r00m",
    schemaVersion: 1,
    kind: "cell.lane.retime",
    projectId: "proj-a",
    fileId: "file-x",
    cellId: "cell-1",
    parentId: null,
    author: "alice",
    payload,
    clientTs: Date.now(),
  } as unknown as RawEvent<"cell.lane.retime">
}

const token = () => makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x", role: ROLE.CONTRIBUTOR })

describe("a line's room at the perimeter", () => {
  it("is refused, saying why, when the line lives in another file than the event names", async () => {
    const result = await authorize(await token(), retime({ recordingsRoomMs: 0 }), SECRET, makeDb("file-cues"))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(422)
      expect(result.reason).toMatch(/not in the file/)
    }
  })

  it("is let through for a line of the file it names", async () => {
    const result = await authorize(await token(), retime({ recordingsRoomMs: 0 }), SECRET, makeDb("file-x"))
    expect(result.ok).toBe(true)
  })

  it("is let through for a line not created yet (made in the same flush): the room lands once it is", async () => {
    const result = await authorize(await token(), retime({ recordingsRoomMs: null }), SECRET, makeDb(null))
    expect(result.ok).toBe(true)
  })

  it("an older client's retime without a room is never looked up", async () => {
    const db = makeDb("file-cues")
    const result = await authorize(await token(), retime({ targetOffsetMs: 200 }), SECRET, db)
    expect(result.ok).toBe(true)
    expect(db.cellReads).toBe(0)
  })
})
