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
let cacheAvailable = true
vi.mock("./bytes-cache", () => ({
  audioCacheAvailable: async () => cacheAvailable,
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
const gateState = vi.hoisted(() => ({
  value: { kind: "go", maxWorkers: Number.POSITIVE_INFINITY } as
    | { kind: "stop"; reason: "metered" | "slow" }
    | { kind: "wait" }
    | { kind: "go"; maxWorkers: number },
}))
vi.mock("./warm-policy", () => ({ warmGate: () => gateState.value }))

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
  cacheAvailable = true
  gateState.value = { kind: "go", maxWorkers: Number.POSITIVE_INFINITY }
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

  it("no persistent cache (private browsing) → downloads NOTHING", async () => {
    // Without OPFS every put is a silent no-op — the sweep used to download
    // the whole file's clips on every lens entry and store none of them.
    cacheAvailable = false
    const res = await warmFileDubs({ cells: [dubbed("a"), dubbed("b")], projectId: "p", session })
    expect(res.stopped).toBe("cache-unavailable")
    expect(fetched.length).toBe(0)
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

describe("warmFileDubs — connection manners (2026-08-05)", () => {
  it("a metered connection stops the sweep before any fetch", async () => {
    gateState.value = { kind: "stop", reason: "metered" }
    const res = await warmFileDubs({ cells: [dubbed("a"), dubbed("b")], projectId: "p", session })
    expect(res.stopped).toBe("metered")
    expect(fetched.length).toBe(0)
  })

  it("a 2g-class connection likewise", async () => {
    gateState.value = { kind: "stop", reason: "slow" }
    const res = await warmFileDubs({ cells: [dubbed("a")], projectId: "p", session })
    expect(res.stopped).toBe("slow")
    expect(fetched.length).toBe(0)
  })

  it("yields while live playback loads, then proceeds when it clears", async () => {
    vi.useFakeTimers()
    try {
      gateState.value = { kind: "wait" }
      const p = warmFileDubs({ cells: [dubbed("a"), dubbed("b")], projectId: "p", session })
      await vi.advanceTimersByTimeAsync(600) // a few park cycles
      expect(fetched.length).toBe(0)
      gateState.value = { kind: "go", maxWorkers: Number.POSITIVE_INFINITY }
      await vi.advanceTimersByTimeAsync(300)
      const res = await p
      expect(res).toMatchObject({ warmed: 2, stopped: "done" })
      expect(fetched.length).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("maxWorkers 1 bounds the fetches actually in flight", async () => {
    vi.useFakeTimers()
    try {
      gateState.value = { kind: "go", maxWorkers: 1 }
      let inFlight = 0
      let maxInFlight = 0
      const upload = await import("./upload")
      vi.mocked(upload.fetchCellAudio).mockImplementation(async ({ audioId }: { audioId: string }) => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 50))
        inFlight--
        fetched.push(audioId)
        return new Uint8Array(1024)
      })
      const p = warmFileDubs({
        cells: [dubbed("a"), dubbed("b"), dubbed("c")],
        projectId: "p",
        session,
        concurrency: 2,
      })
      await vi.advanceTimersByTimeAsync(2000)
      const res = await p
      expect(res.warmed).toBe(3)
      expect(maxInFlight).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("a connection that flips to metered mid-sweep stops after the current item", async () => {
    const upload = await import("./upload")
    vi.mocked(upload.fetchCellAudio).mockImplementation(async ({ audioId }: { audioId: string }) => {
      fetched.push(audioId)
      gateState.value = { kind: "stop", reason: "metered" } // flips DURING the first fetch
      return new Uint8Array(1024)
    })
    const res = await warmFileDubs({
      cells: [dubbed("a"), dubbed("b"), dubbed("c")],
      projectId: "p",
      session,
      concurrency: 1,
    })
    expect(res.stopped).toBe("metered")
    expect(fetched.length).toBe(1)
  })
})
