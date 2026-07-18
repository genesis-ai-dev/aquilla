// useDcsUpstreamCursor — the settings→capability bridge for the DCS source
// lockdown. Encodes two contracts:
//   1. loading is true until the settings GET resolves — callers (EditorTable)
//      treat loading as LOCKED, so a Door43-linked project can never flash an
//      editable source lane while the cursor is still in flight.
//   2. an explicit `dcsUpstream: null` (the detach write) reads as ABSENT —
//      detaching must actually unlock, and garbage never parses as a cursor.

import { describe, it, expect, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { useDcsUpstreamCursor } from "./useDcsUpstreamCursor"
import type { DcsCursor } from "@/lib/dcs/types"

let settingsBag: Record<string, unknown> = {}
let hasFetched = false
vi.mock("@/hooks/useProjectSettings", () => ({
  useProjectSettings: () => ({ settings: settingsBag, hasFetched }),
}))

const CURSOR: DcsCursor = {
  owner: "unfoldingWord",
  repo: "en_ult",
  subject: "Aligned Bible",
  contentFormat: "usfm",
  trackMode: "release",
  ref: "v88",
  commitSha: "aaa111",
  released: "2026-05-01T00:00:00Z",
  importedAt: "2026-07-01T00:00:00Z",
}

function run() {
  return renderHook(() => useDcsUpstreamCursor("proj-1", 600)).result.current
}

describe("useDcsUpstreamCursor", () => {
  it("is loading (linked-state unknown) until the settings fetch resolves", () => {
    settingsBag = {}
    hasFetched = false
    const { cursor, loading } = run()
    expect(loading).toBe(true)
    expect(cursor).toBeNull()
  })

  it("returns the parsed cursor once settings carry dcsUpstream", () => {
    settingsBag = { dcsUpstream: CURSOR }
    hasFetched = true
    const { cursor, loading } = run()
    expect(loading).toBe(false)
    expect(cursor).toEqual(CURSOR)
  })

  it("treats an explicit dcsUpstream: null (post-detach) as absent", () => {
    settingsBag = { dcsUpstream: null }
    hasFetched = true
    const { cursor, loading } = run()
    expect(loading).toBe(false)
    expect(cursor).toBeNull()
  })

  it("treats undefined and garbage cursor values as absent", () => {
    hasFetched = true
    for (const bad of [undefined, "v88", 42, { ref: "v1" }, []]) {
      settingsBag = { dcsUpstream: bad }
      expect(run().cursor).toBeNull()
    }
  })
})
