// Decision 11: the history follows the person between devices (P13.2), and
// two devices of one person never undo the same step twice (P13.7). The
// server is faked with the same revision rule as auth-worker's edit-history
// route: a write names the revision it was built on, or it is refused with
// the current copy. An Undo asks the server first only when another device
// wrote recently (Sam, Oct 22).
import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  OTHER_DEVICE_WINDOW_MS,
  flushHistorySaveForTests,
  historyReady,
  historyView,
  recordStep,
  redoLast,
  refreshHistory,
  registerStepKinds,
  resetHistoryForTests,
  setHistoryRemote,
  setHistoryScope,
  settleHistorySyncForTests,
  subscribeHistory,
  undoLast,
  type StepHandler,
  type StepRecord,
} from "./history"
import { clearHistoryStoreForTests } from "./history-store"
import { emptyHistoryDoc, mergeDevices, mergeHistories, type HistoryDoc } from "./history-merge"
import type { HistoryRemote } from "./history-remote"

class FakeServer {
  rows = new Map<string, { revision: number; history: HistoryDoc }>()
  online = true
  /** Reads never answer (a server that is up but stuck). */
  hang = false
  writes = 0
  reads = 0
  /** Bodies longer than this are refused, as the route refuses over 2 MB (413). */
  maxChars = Number.POSITIVE_INFINITY
  refused = 0
  as(user: string): HistoryRemote {
    const key = (projectId: string) => `${projectId}|${user}`
    const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T
    return {
      read: async (projectId, since) => {
        this.reads += 1
        if (this.hang) return new Promise(() => {})
        if (!this.online) return null
        const row = this.rows.get(key(projectId))
        if (!row) return { kind: "copy", revision: 0, history: null }
        if (since === row.revision) return { kind: "unchanged", revision: row.revision }
        return { kind: "copy", revision: row.revision, history: copy(row.history) }
      },
      write: async (projectId, baseRevision, history) => {
        if (!this.online) return null
        if (JSON.stringify({ baseRevision, history }).length > this.maxChars) {
          this.refused += 1
          return { kind: "tooLarge" }
        }
        const row = this.rows.get(key(projectId))
        const current = row?.revision ?? 0
        if (baseRevision !== current) return { kind: "conflict", revision: current, history: row ? copy(row.history) : null }
        this.writes += 1
        this.rows.set(key(projectId), { revision: current + 1, history: copy(history) })
        return { kind: "saved", revision: current + 1 }
      },
    }
  }
  copyOf(projectId: string, user: string): HistoryDoc | undefined {
    return this.rows.get(`${projectId}|${user}`)?.history
  }
}

/** A step kind that counts its writes. */
function counting(log: string[]): StepHandler<never> {
  return {
    undo: async (d: { name: string }) => {
      log.push(`undo ${d.name}`)
      return { kind: "done" }
    },
    redo: async (d: { name: string }) => {
      log.push(`redo ${d.name}`)
      return { kind: "done" }
    },
  } as StepHandler<never>
}

const step = (name: string) => ({ kind: "test.log", data: { name }, labelKey: name, lane: "Swahili" })

/** Open the project on a fresh computer or browser: nothing in memory or saved. */
async function openOnNewDevice(server: FakeServer, user: string, log: string[]): Promise<void> {
  resetHistoryForTests()
  await clearHistoryStoreForTests()
  registerStepKinds({ "test.log": counting(log) })
  setHistoryRemote(server.as(user))
  setHistoryScope("p1", user, "Swahili")
  await historyReady()
  await settleHistorySyncForTests()
}

async function settle(): Promise<void> {
  await flushHistorySaveForTests()
  await settleHistorySyncForTests()
}

/** Reload the tab: memory goes; this browser's saved copy and the tab's name stay. */
async function openSameTabAgain(): Promise<void> {
  const name = sessionStorage.getItem("aquilla.history.device")
  expect(name).toBeTruthy()
  resetHistoryForTests()
  sessionStorage.setItem("aquilla.history.device", name as string)
  registerStepKinds({ "test.log": counting(log) })
  setHistoryRemote(server.as("asha"))
  setHistoryScope("p1", "asha", "Swahili")
  await historyReady()
  await settleHistorySyncForTests()
}

/** A step as another device records it. */
const made = (name: string, at = Date.now()): StepRecord => ({
  id: `elsewhere-${name}`,
  kind: "test.log",
  data: { name },
  labelKey: name,
  at,
  lane: "Swahili",
})

/** Asha's other computer changes the server's copy, signing it the way history.ts does. */
async function writeOnComputerA(change: (h: HistoryDoc) => HistoryDoc, at = Date.now()): Promise<void> {
  const a = server.as("asha")
  const seen = await a.read("p1", null)
  const base = seen?.kind === "copy" ? seen.revision : 0
  const current = (seen?.kind === "copy" && seen.history) || emptyHistoryDoc()
  await a.write("p1", base, { ...change(current), devices: mergeDevices(current.devices, [{ id: "computer-a", at }]) })
}

let server: FakeServer
let log: string[]

beforeEach(async () => {
  server = new FakeServer()
  log = []
  await openOnNewDevice(server, "asha", log)
})

describe("the history follows the person (P13.2)", () => {
  it("steps made on one device are there on another, with their language, and undo and redo carry over", async () => {
    recordStep(step("Move take"))
    recordStep(step("Rename take"))
    await settle()

    // Computer B.
    await openOnNewDevice(server, "asha", log)
    expect(historyView().undoSteps.map((s) => [s.labelKey, s.lane])).toEqual([
      ["Move take", "Swahili"],
      ["Rename take", "Swahili"],
    ])
    expect((await undoLast())?.step.labelKey).toBe("Rename take")
    await settle()

    // Back on A.
    await openOnNewDevice(server, "asha", log)
    expect(historyView().undoSteps.map((s) => s.labelKey)).toEqual(["Move take"])
    expect(historyView().redoSteps.map((s) => s.labelKey)).toEqual(["Rename take"])
    expect((await redoLast())?.step.labelKey).toBe("Rename take")
    expect(log).toEqual(["undo Rename take", "redo Rename take"])
  })

  it("nobody else ever sees a person's steps", async () => {
    recordStep(step("Rename take"))
    await settle()
    await openOnNewDevice(server, "juma", log)
    expect(historyView().undoSteps).toEqual([])
  })

  it("steps made offline reach the server once the connection is back", async () => {
    server.online = false
    recordStep(step("Offline trim"))
    await settle()
    expect(server.copyOf("p1", "asha")).toBeUndefined()
    server.online = true
    window.dispatchEvent(new Event("online"))
    await settleHistorySyncForTests()
    expect(server.copyOf("p1", "asha")?.undo.map((r) => r.labelKey)).toEqual(["Offline trim"])
  })

  // Review, Oct 29: the tab may close before the connection comes back.
  it("steps made offline reach the server after a reload, even when the server has not changed", async () => {
    recordStep(step("Online trim"))
    await settle()
    server.online = false
    recordStep(step("Offline trim"))
    await settle()
    server.online = true
    await openSameTabAgain()
    await settle()
    expect(server.copyOf("p1", "asha")?.undo.map((r) => r.labelKey)).toEqual(["Online trim", "Offline trim"])
  })

  // Review, Oct 29: the server's row can go (deleted, a restored database)
  // while this browser still names the revision it last saw.
  it("a server copy that went missing is written again, not refused forever", async () => {
    recordStep(step("First"))
    await settle()
    server.rows.clear()
    recordStep(step("Second"))
    await settle()
    expect(server.copyOf("p1", "asha")?.undo.map((r) => r.labelKey)).toEqual(["First", "Second"])
  })

  // Review, Oct 29: the server keeps at most 2 MB of history. Past that, the
  // oldest steps give way, rather than every later step sending megabytes
  // that are refused and the history no longer following the person.
  it("a history too large for the server keeps its newest steps that fit", async () => {
    server.maxChars = 2 * 1024 * 1024
    const big = (name: string) => ({ ...step(name), data: { name, filler: "x".repeat(1_100_000) } })
    recordStep(big("Validated chapter 1"))
    await settle()
    recordStep(big("Validated chapter 2"))
    await settle()
    recordStep(step("Rename take"))
    await settle()
    expect(server.refused).toBe(0)
    expect(server.copyOf("p1", "asha")?.undo.map((r) => r.labelKey)).toEqual(["Validated chapter 2", "Rename take"])
    expect(historyView().undoSteps.map((s) => s.labelKey)).toEqual(["Validated chapter 2", "Rename take"])
  })

  it("opening the History panel picks up steps made elsewhere since", async () => {
    // Another device of Asha's writes a step after this one opened.
    const other = server.as("asha")
    const current = await other.read("p1", null)
    const base = current?.kind === "copy" ? current.revision : 0
    await other.write("p1", base, {
      undo: [{ id: "elsewhere-1", kind: "test.log", data: { name: "Elsewhere" }, labelKey: "Elsewhere", at: Date.now(), lane: "Swahili" }],
      redo: [],
      log: [],
      gone: [],
    })
    expect(historyView().undoSteps).toEqual([])
    await refreshHistory()
    expect(historyView().undoSteps.map((s) => s.labelKey)).toEqual(["Elsewhere"])
  })
})

describe("two devices at once (P13.7)", () => {
  it("writing at the same time loses no steps", async () => {
    recordStep(step("First"))
    await settle()
    // Device A sneaks a step in on top of what this device last saw.
    const a = server.as("asha")
    const seen = await a.read("p1", null)
    if (seen?.kind !== "copy" || !seen.history) throw new Error("expected a copy")
    await a.write("p1", seen.revision, {
      ...seen.history,
      undo: [...seen.history.undo, { id: "from-a", kind: "test.log", data: { name: "From A" }, labelKey: "From A", at: seen.history.undo[0].at + 1 }],
    })
    // This device, still on the older revision, records its own.
    await new Promise((r) => setTimeout(r, 5))
    recordStep(step("From B"))
    await settle()
    const stored = server.copyOf("p1", "asha")
    expect(stored?.undo.map((r) => r.labelKey)).toEqual(["First", "From A", "From B"])
    expect(historyView().undoSteps.map((s) => s.labelKey)).toEqual(["First", "From A", "From B"])
  })

  it("a step another device already undid is not undone a second time", async () => {
    // Computer A renames a take; this computer picks the step up (its History panel opens).
    await writeOnComputerA((h) => ({ ...h, undo: [...h.undo, made("Rename take")] }))
    await refreshHistory()
    expect(historyView().undoSteps.map((s) => s.labelKey)).toEqual(["Rename take"])
    // A undoes it (moved to Redo, later than this copy knows).
    await writeOnComputerA((h) => ({ ...h, undo: [], redo: [{ ...h.undo[0], movedAt: Date.now() + 5 }] }))

    // This computer still shows it on Undo, and presses Undo. A wrote a moment
    // ago, so it asks the server first.
    const reads = server.reads
    const result = await undoLast()
    expect(server.reads).toBe(reads + 1)
    expect(result?.outcome).toEqual({ kind: "moved" })
    expect(log).toEqual([]) // nothing written here
    expect(historyView().undoSteps).toEqual([])
    expect(historyView().redoSteps.map((s) => s.labelKey)).toEqual(["Rename take"])
  })

  // Sam, Oct 28 ("happy with all your decisions"): after "… was already
  // undone on another of your devices", this device's History panel must
  // update at once, so its next Undo acts on what the panel then shows — here,
  // this device's own older step (the P13.7 walk: A undid the 1:9 rename, and
  // B's next Undo took B's own 1:7 rename).
  it("after a step another device took, the panel updates at once and the next Undo takes this device's own step", async () => {
    recordStep(step("Rename 1:7"))
    await settle()
    await writeOnComputerA((h) => ({ ...h, undo: [...h.undo, made("Rename 1:9", h.undo[0].at + 1)] }))
    await refreshHistory()
    expect(historyView().undoSteps.map((s) => s.labelKey)).toEqual(["Rename 1:7", "Rename 1:9"])
    await writeOnComputerA((h) => ({
      ...h,
      undo: h.undo.filter((r) => r.labelKey !== "Rename 1:9"),
      redo: [{ ...h.undo.find((r) => r.labelKey === "Rename 1:9")!, movedAt: Date.now() + 5 }],
    }))

    const panel = vi.fn()
    const off = subscribeHistory(panel)
    const result = await undoLast()
    expect(result?.outcome).toEqual({ kind: "moved" })
    expect(panel).toHaveBeenCalled()
    off()
    expect(historyView().undoSteps.map((s) => s.labelKey)).toEqual(["Rename 1:7"])
    expect(historyView().redoSteps.map((s) => s.labelKey)).toEqual(["Rename 1:9"])
    expect(log).toEqual([])

    expect((await undoLast())?.outcome.kind).toBe("done")
    expect(log).toEqual(["undo Rename 1:7"])
  })

  // Review, Oct 29: a NEW step from another device is not that device taking
  // this one. The press undoes the step the button named; the other device's
  // step stays on Undo, and the next press takes it.
  it("a new step made on another device meanwhile does not stop this Undo", async () => {
    recordStep(step("Rename 1:7"))
    await settle()
    // Computer A is in use (this copy has heard from it), then makes a step.
    await writeOnComputerA((h) => h)
    await refreshHistory()
    await writeOnComputerA((h) => ({ ...h, undo: [...h.undo, made("Rename 1:9", h.undo[0].at + 1)] }))

    const reads = server.reads
    const result = await undoLast()
    expect(server.reads).toBe(reads + 1)
    expect(result?.step.labelKey).toBe("Rename 1:7")
    expect(result?.outcome.kind).toBe("done")
    expect(log).toEqual(["undo Rename 1:7"])
    expect(historyView().undoSteps.map((s) => s.labelKey)).toEqual(["Rename 1:9"])
    expect(historyView().redoSteps.map((s) => s.labelKey)).toEqual(["Rename 1:7"])
  })

  it("it waits at most 1.5 s for the server's answer, then undoes", async () => {
    await writeOnComputerA((h) => ({ ...h, undo: [...h.undo, made("Rename take")] }))
    await refreshHistory()
    server.hang = true
    const started = Date.now()
    expect((await undoLast())?.outcome.kind).toBe("done")
    const waited = Date.now() - started
    expect(waited).toBeGreaterThanOrEqual(1400)
    expect(waited).toBeLessThan(4000)
    expect(log).toEqual(["undo Rename take"])
  })

  it("offline, an undo still runs (its own guard stands between it and a second write)", async () => {
    await writeOnComputerA((h) => ({ ...h, undo: [...h.undo, made("Trim")] }))
    await refreshHistory()
    server.online = false
    expect((await undoLast())?.outcome.kind).toBe("done")
    expect(log).toEqual(["undo Trim"])
  })
})

describe("one device on its own does not wait (Sam, Oct 22)", () => {
  it("an undo goes at once, without asking the server", async () => {
    recordStep(step("Trim"))
    await settle()
    server.hang = true
    const reads = server.reads
    expect((await undoLast())?.outcome.kind).toBe("done")
    expect(server.reads).toBe(reads)
    expect(log).toEqual(["undo Trim"])
  })

  it("a reload is still the same device", async () => {
    recordStep(step("Trim"))
    await settle()
    await openSameTabAgain()
    server.hang = true
    const reads = server.reads
    expect((await undoLast())?.outcome.kind).toBe("done")
    expect(server.reads).toBe(reads)
  })

  it("another device that last wrote more than five minutes ago does not make it wait", async () => {
    const longAgo = Date.now() - OTHER_DEVICE_WINDOW_MS - 60_000
    await writeOnComputerA((h) => ({ ...h, undo: [...h.undo, made("Rename take", longAgo)] }), longAgo)
    await refreshHistory()
    server.hang = true
    const reads = server.reads
    expect((await undoLast())?.outcome.kind).toBe("done")
    expect(server.reads).toBe(reads)
    expect(log).toEqual(["undo Rename take"])
  })

  it("another device that wrote within five minutes does make it ask", async () => {
    const lately = Date.now() - OTHER_DEVICE_WINDOW_MS + 60_000
    await writeOnComputerA((h) => ({ ...h, undo: [...h.undo, made("Rename take", lately)] }), lately)
    await refreshHistory()
    const reads = server.reads
    expect((await undoLast())?.outcome.kind).toBe("done")
    expect(server.reads).toBe(reads + 1)
  })

  it("this device signs what it sends, and learns of the others from what it receives", async () => {
    recordStep(step("Trim"))
    await settle()
    const mine = server.copyOf("p1", "asha")?.devices ?? []
    expect(mine).toHaveLength(1)
    await writeOnComputerA((h) => h)
    expect(server.copyOf("p1", "asha")?.devices?.map((d) => d.id).sort()).toEqual([mine[0].id, "computer-a"].sort())
    await refreshHistory()
    await settle()
    // Kept in this browser too: after a reload with the server out of reach,
    // an Undo still knows A is in use, and tries to ask.
    server.online = false
    await openSameTabAgain()
    const reads = server.reads
    expect((await undoLast())?.outcome.kind).toBe("done")
    expect(server.reads).toBe(reads + 1)
  })
})

// Review, Oct 29: a step is saved as moved before it runs; when its handler
// then answers "blocked" it goes back, and that going back must be the newest
// word on where it is, for every copy that saw it in flight.
describe("a step that turned out blocked while it ran", () => {
  it("is back on Undo in every copy, including one that saw it on Redo", async () => {
    let inFlight: HistoryDoc | null = null
    registerStepKinds({
      "test.blocked": {
        undo: async () => {
          await new Promise((r) => setTimeout(r, 20))
          await settleHistorySyncForTests()
          inFlight = JSON.parse(JSON.stringify(server.copyOf("p1", "asha"))) as HistoryDoc
          return { kind: "blocked", reason: "elsewhere" }
        },
        redo: async () => ({ kind: "done" }),
      } as StepHandler<never>,
    })
    recordStep({ kind: "test.blocked", data: {}, labelKey: "Imported a recording", lane: "Swahili" })
    await settle()
    expect((await undoLast())?.outcome.kind).toBe("blocked")
    await settle()
    expect(inFlight!.redo.map((r) => r.labelKey)).toEqual(["Imported a recording"])
    // Another device pulled the in-flight copy and merges the server's now.
    const elsewhere = mergeHistories(inFlight!, server.copyOf("p1", "asha")!, { steps: 100, log: 30 })
    expect(elsewhere.undo.map((r) => r.labelKey)).toEqual(["Imported a recording"])
    expect(elsewhere.redo).toEqual([])
  })
})

// Review, Oct 29: each device stamps steps with its own clock, and clocks
// disagree. What this device does after seeing a step must still count as
// later than that step, wherever the copies are merged.
describe("devices whose clocks disagree", () => {
  const AHEAD_MS = 120_000 // computer A's clock runs two minutes ahead of this one

  it("an undo made here still wins over the copy it undid", async () => {
    const ahead = Date.now() + AHEAD_MS
    await writeOnComputerA((h) => ({ ...h, undo: [...h.undo, made("Rename take", ahead)] }), ahead)
    await refreshHistory()
    expect((await undoLast())?.outcome.kind).toBe("done")
    await settle()
    // Computer A still holds its own copy, the step on Undo, and merges the server's.
    const onA = mergeHistories(
      { ...emptyHistoryDoc(), undo: [made("Rename take", ahead)] },
      server.copyOf("p1", "asha")!,
      { steps: 100, log: 30 },
    )
    expect(onA.undo.map((r) => r.labelKey)).toEqual([])
    expect(onA.redo.map((r) => r.labelKey)).toEqual(["Rename take"])
  })

  it("a step made here after one from a device whose clock is ahead is undone first", async () => {
    const ahead = Date.now() + AHEAD_MS
    await writeOnComputerA((h) => ({ ...h, undo: [...h.undo, made("From A", ahead)] }), ahead)
    await refreshHistory()
    recordStep(step("From B"))
    await settle()
    await openOnNewDevice(server, "asha", log)
    expect(historyView().undoSteps.map((s) => s.labelKey)).toEqual(["From A", "From B"])
    expect((await undoLast())?.step.labelKey).toBe("From B")
  })
})
