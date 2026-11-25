import { afterEach, describe, expect, it, vi } from "vitest"
import {
  cannotConfirmPersist,
  forgetStallRescueForTests,
  holdJournalUntilPersisted,
  isInOutboxInstead,
  isRescuedFromOfflineQueue,
  noteRescuedOutcomes,
  rescuedOutcome,
  rescueUnpersistedOfflineWrites,
  untilJournalClearedOrStalled,
} from "./offline-stall-rescue"
import { __resetLeaderStalledForTests, setLeaderStalled } from "@/lib/offline/leader-watchdog"
import type { OutboxRecord } from "./outbox"

const neverPersisted = () => () => {}

afterEach(() => {
  forgetStallRescueForTests()
  __resetLeaderStalledForTests()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("rescueUnpersistedOfflineWrites", () => {
  it("hands the rows to IndexedDB before the copy lands, so neither queue sends them twice", async () => {
    holdJournalUntilPersisted([{ id: "e1", event: { projectId: "p1" } } as OutboxRecord], neverPersisted, () => {}, () => {})
    let markedDuringCopy = false
    await rescueUnpersistedOfflineWrites(async () => {
      markedDuringCopy = isRescuedFromOfflineQueue("e1")
    })
    expect(markedDuringCopy).toBe(true)
    expect(isRescuedFromOfflineQueue("e1")).toBe(true)
  })

  it("gives the rows back to the offline queue when the copy fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const clearJournal = vi.fn()
    holdJournalUntilPersisted([{ id: "e1", event: { projectId: "p1" } } as OutboxRecord], neverPersisted, clearJournal, () => {})
    const safe = await rescueUnpersistedOfflineWrites(async () => {
      throw new Error("disk full")
    })
    expect(safe).toBe(false)
    expect(isRescuedFromOfflineQueue("e1")).toBe(false)
    expect(clearJournal).not.toHaveBeenCalled()
  })
})

describe("isInOutboxInstead", () => {
  it("is false until the rescue's copy has landed, so children of the row stay held back", async () => {
    holdJournalUntilPersisted([{ id: "e1", event: { projectId: "p1" } } as OutboxRecord], neverPersisted, () => {}, () => {})
    let duringCopy: boolean | undefined
    await rescueUnpersistedOfflineWrites(async () => {
      duringCopy = isInOutboxInstead("e1")
    })
    expect(duringCopy).toBe(false)
    expect(isInOutboxInstead("e1")).toBe(true)
  })
})

describe("holdJournalUntilPersisted on a store that can't confirm", () => {
  it("asks for a rescue straight away, and the rescue clears the entry", async () => {
    const clearJournal = vi.fn()
    const rescue = vi.fn()
    holdJournalUntilPersisted([{ id: "e1", event: { projectId: "p1" } } as OutboxRecord], cannotConfirmPersist, clearJournal, rescue)
    expect(rescue).toHaveBeenCalledOnce()
    expect(clearJournal).not.toHaveBeenCalled()

    expect(await rescueUnpersistedOfflineWrites(async () => {})).toBe(true)
    expect(clearJournal).toHaveBeenCalledOnce()
  })
})

describe("noteRescuedOutcomes", () => {
  it("records outcomes for rescued ids only, and returns the refused ones to hand back", async () => {
    holdJournalUntilPersisted([{ id: "e1", event: { projectId: "p1" } } as OutboxRecord], neverPersisted, () => {}, () => {})
    await rescueUnpersistedOfflineWrites(async () => {})
    const handedBack = noteRescuedOutcomes({ stale: ["other"], refused: ["e1", "other2"] })
    expect([...handedBack]).toEqual(["e1"])
    expect(rescuedOutcome("e1")).toBe("refused")
    expect(rescuedOutcome("other")).toBeUndefined()
  })
})

describe("rescueUnpersistedOfflineWrites after an error", () => {
  it("still finishes, and later rescues still run, when clearing a journal entry throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    holdJournalUntilPersisted([{ id: "e1", event: { projectId: "p1" } } as OutboxRecord], neverPersisted, () => {
      throw new Error("localStorage gone")
    }, () => {})
    expect(await rescueUnpersistedOfflineWrites(async () => {})).toBe(true)

    const copy = vi.fn(async () => {})
    holdJournalUntilPersisted([{ id: "e2", event: { projectId: "p1" } } as OutboxRecord], neverPersisted, () => {}, () => {})
    expect(await rescueUnpersistedOfflineWrites(copy)).toBe(true)
    expect(copy).toHaveBeenCalledOnce()
  })
})

describe("untilJournalClearedOrStalled", () => {
  it("waits for the journal entry to clear", async () => {
    let clear = () => {}
    const cleared = new Promise<void>((resolve) => {
      clear = resolve
    })
    let done = false
    void untilJournalClearedOrStalled(cleared).then(() => {
      done = true
    })
    await Promise.resolve()
    expect(done).toBe(false)
    clear()
    await vi.waitFor(() => expect(done).toBe(true))
  })

  it("stops waiting once the leader is reported stalled", async () => {
    const wait = untilJournalClearedOrStalled(new Promise<void>(() => {}))
    setLeaderStalled(true)
    await expect(wait).resolves.toBeUndefined()
  })

  it("gives up after the backstop", async () => {
    vi.useFakeTimers()
    const wait = untilJournalClearedOrStalled(new Promise<void>(() => {}), 1_000)
    vi.advanceTimersByTime(1_000)
    await expect(wait).resolves.toBeUndefined()
  })
})
