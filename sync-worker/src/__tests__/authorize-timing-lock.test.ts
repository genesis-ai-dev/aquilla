// AQU-646: the project-wide timing lock, at the perimeter that enforces it.
//
// Sam wanted this refused by the SERVER, not only hidden in the app, so these
// are the tests that matter: the ones that hold when the browser lies. The
// interesting cases are all about who the lock lets THROUGH — a locked project
// that blocked an import's retimes would be worse than no lock at all.
import { describe, it, expect } from "vitest"
import { authorize } from "../events/authorize"
import { makeTestToken } from "./helpers/auth"
import { ROLE } from "../events/role-policy"
import type { RawEvent } from "../events/types"

const SECRET = "test-secret-value-for-timing-lock"

/** project_settings -> the lock; cells -> the user-inserted exemption. */
function makeDb(options: { locked?: boolean; userInserted?: boolean }): AquillaDb {
  const { locked = true, userInserted = false } = options
  return {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM project_settings")) {
                return { settings: JSON.stringify(locked ? {} : { timingLocked: false }) }
              }
              if (sql.includes("FROM cells")) {
                return userInserted
                  ? { metadata: { aquillaOrigin: { version: 1, kind: "user-insert" } } }
                  : { metadata: { cast_name: "JESUS" } }
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

function retime(kind: "cell.retime" | "cell.lane.retime" = "cell.retime"): RawEvent<"cell.retime"> {
  return {
    id: "00000000-0000-7000-0000-00000000f00d",
    schemaVersion: 1,
    kind,
    projectId: "proj-a",
    fileId: "file-x",
    cellId: "cell-1",
    parentId: null,
    author: "alice",
    payload: { startMs: 1000, endMs: 2000 },
    clientTs: Date.now(),
  } as unknown as RawEvent<"cell.retime">
}

const tokenFor = (role: number) =>
  makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x", role })

describe("the timing lock at the perimeter", () => {
  it("refuses a contributor's drag while locked", async () => {
    const result = await authorize(await tokenFor(ROLE.CONTRIBUTOR), retime(), SECRET, makeDb({ locked: true }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(403)
      expect(result.reason).toMatch(/timing is locked/)
    }
  })

  it("refuses a PROJECT LEAD's drag too — the point Sam was explicit about", async () => {
    // "Don't make project leads always be unlocked because I think they could
    // mess that up as well unintentionally."
    const result = await authorize(await tokenFor(ROLE.PROJECT_LEAD), retime(), SECRET, makeDb({ locked: true }))
    expect(result.ok).toBe(false)
  })

  it("covers a per-lane retime that moves a SUBTITLE", async () => {
    const ev = { ...retime("cell.lane.retime"), payload: { subtitleStartMs: 1000, subtitleEndMs: 2000 } } as unknown as RawEvent<"cell.retime">
    const result = await authorize(await tokenFor(ROLE.CONTRIBUTOR), ev, SECRET, makeDb({ locked: true }))
    expect(result.ok).toBe(false)
  })

  it("lets a contributor place their OWN dub take while locked", async () => {
    // `cell.lane.retime` carries two unrelated things. Where a recordist puts
    // their take is their own work, produced here — locking it would stop
    // ordinary dubbing, which is the opposite of protecting the client's file.
    const ev = { ...retime("cell.lane.retime"), payload: { targetOffsetMs: 250 } } as unknown as RawEvent<"cell.retime">
    const result = await authorize(await tokenFor(ROLE.CONTRIBUTOR), ev, SECRET, makeDb({ locked: true }))
    expect(result.ok).toBe(true)
  })

  it("lets a maintainer through — which is what keeps a re-import working", async () => {
    // THE constraint that shaped the design: re-importing an audio VTT retimes
    // every cue through events identical to a drag, and Sam requires that to
    // keep working while locked. Re-import is maintainer-gated, so this is the
    // same test as "an import's retimes are not blocked".
    const result = await authorize(await tokenFor(ROLE.MAINTAINER), retime(), SECRET, makeDb({ locked: true }))
    expect(result.ok).toBe(true)
  })

  it("lets anyone move a line they added themselves", async () => {
    const result = await authorize(
      await tokenFor(ROLE.CONTRIBUTOR), retime(), SECRET, makeDb({ locked: true, userInserted: true }),
    )
    expect(result.ok).toBe(true)
  })

  it("does nothing at all once the project is unlocked", async () => {
    const result = await authorize(await tokenFor(ROLE.CONTRIBUTOR), retime(), SECRET, makeDb({ locked: false }))
    expect(result.ok).toBe(true)
  })

  it("leaves other kinds alone — the pairings keep their own floor", async () => {
    const link = { ...retime(), kind: "cell.link.set", payload: {} } as unknown as RawEvent<"cell.retime">
    // PROJECT_LEAD clears cell.link.set's static floor, and the lock must not
    // add a second opinion on top of it.
    const result = await authorize(await tokenFor(ROLE.PROJECT_LEAD), link, SECRET, makeDb({ locked: true }))
    expect(result.ok).toBe(true)
  })

  it("falls back to the static floor when no db handle is supplied", async () => {
    // Same convention as the self-assign carve-out: every existing caller and
    // test that passes no db keeps working rather than erroring.
    const result = await authorize(await tokenFor(ROLE.CONTRIBUTOR), retime(), SECRET)
    expect(result.ok).toBe(true)
  })
})
