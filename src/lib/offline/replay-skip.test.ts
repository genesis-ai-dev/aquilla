import { describe, expect, it, vi } from "vitest"
import { planReplaySkip, type ReplayRow } from "./replay-skip"

const P = "proj-a"
const Q = "proj-b"

const row = (global: number, client: number, name: string, args: Record<string, unknown>): ReplayRow => ({
  name,
  argsJson: JSON.stringify(args),
  seqNumGlobal: global,
  seqNumClient: client,
})

/** A fake eventlog: `head` is the confirmed sync head (undefined = none recorded). */
function eventlog(rows: ReplayRow[], head: number | undefined) {
  return {
    eventlogTable: "eventlog",
    syncStatusTable: "__livestore_sync_status",
    select: (query: string): Record<string, unknown>[] => {
      if (query.includes("__livestore_sync_status")) return head === undefined ? [] : [{ head }]
      if (query.includes("ORDER BY")) {
        const last = [...rows].sort((a, b) => b.seqNumGlobal - a.seqNumGlobal || b.seqNumClient - a.seqNumClient)[0]
        return last === undefined ? [] : [{ ...last }]
      }
      const names = /name (?:= '([^']+)'|IN \(([^)]+)\))/.exec(query)
      const wanted = names?.[1] !== undefined ? [names[1]] : (names?.[2] ?? "").split(",").map((n) => n.trim().replaceAll("'", ""))
      return rows.filter((r) => wanted.includes(r.name)).map((r) => ({ ...r }))
    },
  }
}

const history = [
  row(1, 0, "v1.ProjectSynced", { id: P }),
  row(1, 1, "v2.CellsSynced", { projectId: P, fileId: "f", rows: [] }),
  row(1, 2, "v2.CellsSynced", { projectId: Q, fileId: "g", rows: [] }),
  row(1, 3, "v1.FileSynced", { id: "f", projectId: P }),
  row(1, 4, "v1.EventQueued", { id: "e1", projectId: P }),
  row(2, 0, "v1.SyncCursorSet", { projectId: P, fileId: "f" }),
  row(3, 0, "v1.OfflineCopyRemoved", { projectId: P }),
  row(3, 1, "v1.OfflineProjectStatusSet", { projectId: P, status: "downloading" }),
  row(3, 2, "v2.CellsSynced", { projectId: P, fileId: "f", rows: [] }),
]

describe("planReplaySkip", () => {
  it("skips a project's events before its last confirmed removal, and nothing else", () => {
    const skip = planReplaySkip(eventlog(history, 5))
    expect(skip).toBeDefined()
    const skipped = history.filter((r) => skip?.(r)).map((r) => `${r.seqNumGlobal}.${r.seqNumClient} ${r.name}`)
    expect(skipped).toEqual(["1.0 v1.ProjectSynced", "1.1 v2.CellsSynced", "2.0 v1.SyncCursorSet"])
  })

  it("keeps queue and file events, and other projects' events", () => {
    const skip = planReplaySkip(eventlog(history, 5))
    expect(skip?.(history[2])).toBe(false) // Q's cells
    expect(skip?.(history[3])).toBe(false) // FileSynced
    expect(skip?.(history[4])).toBe(false) // EventQueued
  })

  it("keeps the removal itself and everything after it", () => {
    const skip = planReplaySkip(eventlog(history, 5))
    expect(history.slice(6).some((r) => skip?.(r))).toBe(false)
  })

  it("only uses the last removal per project", () => {
    const rows = [...history, row(4, 0, "v1.OfflineCopyRemoved", { projectId: P })]
    const skip = planReplaySkip(eventlog(rows, 5))
    expect(skip?.(history[6])).toBe(true) // the earlier removal
    expect(skip?.(history[8])).toBe(true) // the re-download it was followed by
    expect(skip?.(rows[9])).toBe(false)
  })

  it("ignores a removal above the confirmed head", () => {
    expect(planReplaySkip(eventlog(history, 2))).toBeUndefined()
    // e3.0 is at the head itself: confirmed.
    expect(planReplaySkip(eventlog(history, 3))).toBeDefined()
  })

  it("replays everything without a recorded head, or with no removal or dequeue", () => {
    expect(planReplaySkip(eventlog(history, undefined))).toBeUndefined()
    expect(planReplaySkip(eventlog(history.slice(0, 6), 5))).toBeUndefined()
  })

  describe("outbox rows", () => {
    const queue = [
      row(10, 1, "v1.EventQueued", { id: "a" }),
      row(10, 2, "v1.EventQueued", { id: "b" }),
      row(10, 3, "v1.EventQueued", { id: "c" }),
      row(10, 4, "v1.EventQueueStatusSet", { id: "a", status: "failed" }),
      row(11, 0, "v1.EventDequeued", { id: "a" }),
      row(11, 1, "v1.EventsDequeued", { ids: ["b"] }),
      row(12, 0, "v1.EventQueued", { id: "a" }), // re-queued after its dequeue
    ]
    const names = (rows: ReplayRow[], skip: ((r: ReplayRow) => boolean) | undefined) =>
      rows.filter((r) => skip?.(r)).map((r) => `${r.seqNumGlobal}.${r.seqNumClient}`)

    it("skips a row's events up to its last dequeue; batch dequeues are always replayed", () => {
      const skip = planReplaySkip(eventlog(queue, 20))
      // a: queued, status, single dequeue. b: queued only (its batch dequeue is kept).
      expect(names(queue, skip)).toEqual(["10.1", "10.2", "10.4", "11.0"])
    })

    it("keeps rows still in the outbox and anything after the dequeue", () => {
      const skip = planReplaySkip(eventlog(queue, 20))
      expect(skip?.(queue[2])).toBe(false) // c was never dequeued
      expect(skip?.(queue[5])).toBe(false) // the batch dequeue
      expect(skip?.(queue[6])).toBe(false) // a queued again later
    })

    it("ignores dequeues above the confirmed head", () => {
      const skip = planReplaySkip(eventlog(queue, 10))
      expect(skip).toBeUndefined()
      const partly = planReplaySkip(eventlog(queue, 11))
      // e11.0 is confirmed, e11.1 (b's batch dequeue) is not.
      expect(names(queue, partly)).toEqual(["10.1", "10.4", "11.0"])
    })

    describe("batch enqueues", () => {
      const batch = (global: number, client: number, ids: string[]) =>
        row(global, client, "v1.EventsQueued", { rows: ids.map((id) => ({ id, projectId: P })) })

      it("skips a batch once every row in it is dequeued, with its rows' events", () => {
        const rows = [
          batch(10, 1, ["a", "b"]),
          row(10, 2, "v1.EventQueueStatusSet", { id: "a", status: "flushing" }),
          row(11, 0, "v1.EventDequeued", { id: "a" }),
          row(11, 1, "v1.EventsDequeued", { ids: ["b"] }),
          row(12, 0, "v1.LocalCheckpoint", {}),
        ]
        expect(names(rows, planReplaySkip(eventlog(rows, 20)))).toEqual(["10.1", "10.2", "11.0"])
      })

      it("replays a batch with a row still queued, and every event about its rows", () => {
        const rows = [
          batch(10, 1, ["a", "b"]),
          row(10, 2, "v1.EventQueued", { id: "c" }),
          row(11, 0, "v1.EventDequeued", { id: "a" }),
          row(11, 1, "v1.EventDequeued", { id: "c" }),
          row(12, 0, "v1.LocalCheckpoint", {}),
        ]
        // Skipping a's dequeue would bring it back: the batch re-inserts it.
        expect(names(rows, planReplaySkip(eventlog(rows, 20)))).toEqual(["10.2", "11.1"])
      })

      it("replays a batch whose dequeue isn't confirmed yet", () => {
        const rows = [
          batch(10, 1, ["a"]),
          row(11, 0, "v1.EventDequeued", { id: "a" }),
          row(12, 0, "v1.EventDequeued", { id: "x" }),
          row(13, 0, "v1.LocalCheckpoint", {}),
        ]
        expect(names(rows, planReplaySkip(eventlog(rows, 11)))).toEqual(["10.1", "11.0"])
        expect(names(rows, planReplaySkip(eventlog(rows, 10)))).toEqual([])
      })

      it("replays every queue event when a batch's rows can't be read", () => {
        const rows = [
          row(10, 1, "v1.EventsQueued", { rows: "garbled" }),
          row(10, 2, "v1.EventQueued", { id: "a" }),
          row(11, 0, "v1.EventDequeued", { id: "a" }),
          row(12, 0, "v1.LocalCheckpoint", {}),
        ]
        expect(names(rows, planReplaySkip(eventlog(rows, 20)))).toEqual([])
      })
    })
  })

  it("never skips the eventlog's last event, so the rebuilt state db ends on the eventlog's head", () => {
    // A single dequeue of a confirmed row would otherwise be skipped; as the last
    // event it would leave the state head behind and force a rebuild every boot.
    const rows = [row(1, 1, "v1.EventQueued", { id: "a" }), row(1, 2, "v1.EventDequeued", { id: "a" })]
    const skip = planReplaySkip(eventlog(rows, 2))
    expect(skip?.(rows[0])).toBe(true)
    expect(skip?.(rows[1])).toBe(false)
  })

  it("handles clientOnly sequence numbers: confirmed only once a later synced event moves the head", () => {
    // Every skippable event is clientOnly (client > 0); v1.LocalCheckpoint is synced.
    const rows = [
      row(3, 1, "v2.CellsSynced", { projectId: P, fileId: "f", rows: [] }),
      row(3, 2, "v1.OfflineCopyRemoved", { projectId: P }),
      row(4, 0, "v1.LocalCheckpoint", {}),
      row(4, 1, "v1.OfflineProjectStatusSet", { projectId: P, status: "downloading" }),
    ]
    // e3.2 is above a head of 3 (e3.0): not yet confirmed.
    expect(planReplaySkip(eventlog(rows, 3))).toBeUndefined()
    const skip = planReplaySkip(eventlog(rows, 4))
    expect(rows.map((r) => skip?.(r))).toEqual([true, false, false, false])
  })

  it("never throws: a broken eventlog read replays everything, a broken row is kept", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const broken = { ...eventlog(history, 5), select: () => { throw new Error("boom") } }
    expect(planReplaySkip(broken)).toBeUndefined()
    const skip = planReplaySkip(eventlog(history, 5))
    expect(skip?.({ name: "v2.CellsSynced", argsJson: "{not json", seqNumGlobal: 1, seqNumClient: 9 })).toBe(false)
    warn.mockRestore()
  })
})
