// Decision 11: the history follows the person between devices (P13.2), and
// two devices of one person never undo the same step twice (P13.7). The
// server is faked with the same revision rule as auth-worker's edit-history
// route: a write names the revision it was built on, or it is refused with
// the current copy. An Undo asks the server first only when another device
// wrote recently (Sam, Oct 22).
import { describe, it, expect, beforeEach } from "vitest"
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
  undoLast,
  type StepHandler,
  type StepRecord,
} from "./history"
import { clearHistoryStoreForTests } from "./history-store"
import { emptyHistoryDoc, mergeDevices, type HistoryDoc } from "./history-merge"
import type { HistoryRemote } from "./history-remote"

class FakeServer {
  rows = new Map<string, { revision: number; history: HistoryDoc }>()
  online = true
  /** Reads never answer (a server that is up but stuck). */
  hang = false
  writes = 0
  reads = 0
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
