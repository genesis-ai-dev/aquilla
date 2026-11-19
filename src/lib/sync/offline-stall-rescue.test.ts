import { afterEach, describe, expect, it, vi } from "vitest"
import {
  forgetStallRescueForTests,
  holdJournalUntilPersisted,
  isRescuedFromOfflineQueue,
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
    holdJournalUntilPersisted([{ id: "e1" } as OutboxRecord], neverPersisted, () => {})
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
    holdJournalUntilPersisted([{ id: "e1" } as OutboxRecord], neverPersisted, clearJournal)
    const safe = await rescueUnpersistedOfflineWrites(async () => {
      throw new Error("disk full")
    })
    expect(safe).toBe(false)
    expect(isRescuedFromOfflineQueue("e1")).toBe(false)
    expect(clearJournal).not.toHaveBeenCalled()
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
