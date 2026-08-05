// Layer-1 warming: the sweep that stocks the byte cache with a file's dubs.
// The rules under test: nearest-first ordering, skip-what's-stocked, NEVER
// evict to warm (stop at the budget), abort mid-flight, shrug at failures.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const fetched: string[] = []
let cachedIds: Set<string>
let usage: number
let budget: number
let failIds: Set<string>

vi.mock("./upload", async (importActual) => {
  const actual = await importActual<typeof import("./upload")>()
  return {
    ...actual,
    fetchCellAudio: vi.fn(async ({ audioId }: { audioId: string }) => {
      if (failIds.has(audioId)) throw new Error("404")
      fetched.push(audioId)
      return new Uint8Array(1024)
    }),
  }
})
vi.mock("./bytes-cache", () => ({
  audioCacheBudget: async () => budget,
  audioCacheUsage: async () => usage,
  audioCacheHas: async (audioId: string) => cachedIds.has(audioId),
  audioCachePut: vi.fn(async () => {
    usage += 1024
  }),
}))
vi.mock("./sync-token-fetcher", () => ({
  audioSyncTokenFetcherForSession: () => async () => "tok",
}))

import { planWarmOrder, warmFileDubs } from "./warm-dubs"
import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"

const session = { jwt: "t", username: "dev", createdAt: "" } as unknown as FrontierSession

/** A media cell with a selected take (cellId-seeded → a dub). */
function dubbed(id: string): CellData {
  const takeId = `audio-${id}-1700000000-take.webm`
  return {
    id, fileId: "f1", medium: "media", startTime: 0, endTime: 1,
    selectedAudioId: takeId,
    attachments: { [takeId]: { type: "audio", url: `frontier-audio://${takeId}.webm` } },
  } as unknown as CellData
}
const undubbed = (id: string): CellData =>
  ({ id, fileId: "f1", medium: "media", startTime: 0, endTime: 1, attachments: {} }) as unknown as CellData

const takeIdOf = (cellId: string) => `audio-${cellId}-1700000000-take.webm`

beforeEach(() => {
  fetched.length = 0
  cachedIds = new Set()
  usage = 0
  budget = 1024 * 1024
  failIds = new Set()
})

afterEach(() => vi.clearAllMocks())

describe("planWarmOrder", () => {
  it("sweeps outward from the selection, skipping undubbed cells", () => {
    const cells = [dubbed("a"), dubbed("b"), undubbed("x"), dubbed("c"), dubbed("d")]
    const order = planWarmOrder(cells, "c").map((t) => t.cellId)
    // c first, then its neighbours widening (b at distance 2 beats… a at 3, d at 1).
    expect(order[0]).toBe("c")
    expect(order[1]).toBe("d") // distance 1
    expect(order).toEqual(["c", "d", "b", "a"])
  })

  it("file order when nothing is selected", () => {
    const order = planWarmOrder([dubbed("a"), dubbed("b"), dubbed("c")], null).map((t) => t.cellId)
    expect(order).toEqual(["a", "b", "c"])
  })
})

describe("warmFileDubs", () => {
  it("fetches uncached dubs and stores them", async () => {
    const res = await warmFileDubs({ cells: [dubbed("a"), dubbed("b")], projectId: "p", session })
    expect(res).toMatchObject({ warmed: 2, alreadyCached: 0, failed: 0, stopped: "done" })
    expect(fetched.length).toBe(2)
  })

  it("skips clips already in the pantry", async () => {
    cachedIds.add(takeIdOf("a"))
    const res = await warmFileDubs({ cells: [dubbed("a"), dubbed("b")], projectId: "p", session })
    expect(res).toMatchObject({ warmed: 1, alreadyCached: 1 })
    expect(fetched).toEqual([takeIdOf("b")])
  })

  it("STOPS at the budget instead of evicting to keep going", async () => {
    budget = 1024 * 1024
    usage = budget - 1024 // effectively full (headroom is 4MB)
    const res = await warmFileDubs({
      cells: [dubbed("a"), dubbed("b"), dubbed("c")],
      projectId: "p",
      session,
      concurrency: 1,
    })
    expect(res.stopped).toBe("budget")
    expect(res.warmed).toBe(0)
  })

  it("an abort ends the sweep", async () => {
    const controller = new AbortController()
    controller.abort()
    const res = await warmFileDubs({
      cells: [dubbed("a"), dubbed("b")],
      projectId: "p",
      session,
      signal: controller.signal,
    })
    expect(res.stopped).toBe("aborted")
    expect(fetched.length).toBe(0)
  })

  it("a failing clip is skipped, the sweep continues", async () => {
    failIds.add(takeIdOf("a"))
    const res = await warmFileDubs({
      cells: [dubbed("a"), dubbed("b")],
      projectId: "p",
      session,
      concurrency: 1,
    })
    expect(res).toMatchObject({ warmed: 1, failed: 1, stopped: "done" })
  })

  it("no session → a quiet no-op", async () => {
    const res = await warmFileDubs({
      cells: [dubbed("a")],
      projectId: "p",
      session: { jwt: "" } as unknown as FrontierSession,
    })
    expect(res).toMatchObject({ warmed: 0, stopped: "done" })
  })
})
