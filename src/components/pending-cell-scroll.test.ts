import { describe, expect, it } from "vitest"
import {
  PENDING_CELL_SCROLL_MAX_ATTEMPTS,
  restoreMayPark, stepPendingScroll,
  type PendingCellScroll, type PendingScrollAttempt,
} from "./pending-cell-scroll"

const park = (over: Partial<PendingCellScroll> = {}): PendingCellScroll => ({
  cellId: "c1", flash: true, fileId: "f1", source: "link", ...over,
})

/** Run the machine the way the consuming effect does, recording each tick. */
function drive(
  pending: PendingCellScroll,
  files: readonly (string | null)[],
  scrollLandsAt?: number,
): { kinds: string[]; ticks: number } {
  let attempt: PendingScrollAttempt | null = null
  const kinds: string[] = []
  for (let i = 0; i < files.length; i += 1) {
    const step = stepPendingScroll(pending, attempt, files[i])
    kinds.push(step.kind)
    if (step.kind === "give-up") return { kinds, ticks: i + 1 }
    attempt = step.attempt
    const ok = step.kind === "try" && scrollLandsAt !== undefined && i >= scrollLandsAt
    if (ok || step.last) return { kinds, ticks: i + 1 }
  }
  return { kinds, ticks: files.length }
}

describe("who may park over whom", () => {
  it("lets the restore park over nothing, a restore, or a trace", () => {
    expect(restoreMayPark(null)).toBe(true)
    expect(restoreMayPark(park({ source: "restore" }))).toBe(true)
    expect(restoreMayPark(park({ source: "trace" }))).toBe(true)
  })

  it("never lets the restore replace a link", () => {
    // The link is an explicit request; the restore is a convenience. Losing
    // this rule made "go to the first unvalidated cell" appear to land on a
    // random row — the remembered position had quietly replaced it.
    expect(restoreMayPark(park({ source: "link" }))).toBe(false)
  })
})

describe("stepPendingScroll", () => {
  it("tries in the parked file, and stops the moment the scroll lands", () => {
    // Cells stream in: the row appears on the third version bump.
    const run = drive(park(), ["f1", "f1", "f1", "f1"], 2)
    expect(run.kinds).toEqual(["try", "try", "try"])
  })

  it("waits without scrolling while the route has not caught up", () => {
    // The park is made BEFORE the navigation that opens its file. Scrolling
    // the file that is open NOW is the hijack this machine exists to prevent.
    const run = drive(park(), ["other", "other", "f1"], 2)
    expect(run.kinds).toEqual(["wait", "wait", "try"])
  })

  it("gives up when the user leaves the file it was parked for", () => {
    // Departure only counts AFTER arrival — a mismatch before we ever reach
    // the parked file just means the route is still catching up.
    const run = drive(park(), ["f1", "f1", "elsewhere"])
    expect(run.kinds).toEqual(["try", "try", "give-up"])
  })

  it("exhausts its budget on an id the file never produces", () => {
    // A cell deleted since the link was written must not retry on every
    // committed keystroke for the rest of the session.
    const files = Array<string>(PENDING_CELL_SCROLL_MAX_ATTEMPTS + 5).fill("f1")
    const run = drive(park(), files)
    expect(run.ticks).toBe(PENDING_CELL_SCROLL_MAX_ATTEMPTS)
  })

  it("exhausts its budget on a file it never reaches, too", () => {
    const files = Array<string>(PENDING_CELL_SCROLL_MAX_ATTEMPTS + 5).fill("elsewhere")
    const run = drive(park(), files)
    expect(run.ticks).toBe(PENDING_CELL_SCROLL_MAX_ATTEMPTS)
    expect(run.kinds.every((k) => k === "wait")).toBe(true)
  })

  it("hands a FRESH park a full budget", () => {
    // The budget is keyed by cell id, so no parker has to reset a counter.
    let attempt: PendingScrollAttempt | null = null
    for (let i = 0; i < PENDING_CELL_SCROLL_MAX_ATTEMPTS - 1; i += 1) {
      const step = stepPendingScroll(park(), attempt, "f1")
      if (step.kind !== "give-up") attempt = step.attempt
    }
    const step = stepPendingScroll(park({ cellId: "c2" }), attempt, "f1")
    expect(step.kind).toBe("try")
    if (step.kind === "try") {
      expect(step.attempt.attempts).toBe(1)
      expect(step.last).toBe(false)
    }
  })

  it("scrolls anywhere for a park with no file, as the trace parks", () => {
    const step = stepPendingScroll(park({ fileId: null, source: "trace" }), null, "whatever")
    expect(step.kind).toBe("try")
  })

  it("returns a fresh attempt record rather than mutating the old", () => {
    const first = stepPendingScroll(park(), null, "f1")
    expect(first.kind).toBe("try")
    if (first.kind !== "try") return
    const second = stepPendingScroll(park(), first.attempt, "f1")
    expect(first.attempt.attempts).toBe(1)
    if (second.kind === "try") expect(second.attempt.attempts).toBe(2)
  })
})
