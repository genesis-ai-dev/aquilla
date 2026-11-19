// Review M1 + S1/S2 (question 89 ON): auto-even starts only from this tab's
// own actions on a take, never from what the takes look like; a take it
// couldn't even is not tried again this session; it needs a known role.
import { afterEach, describe, expect, it, vi } from "vitest"
import { createAutoEvenQueue } from "./auto-even-queue"
import { noteLocalTakeChange, onLocalTakeChange } from "./local-take-changes"
import type { CellData } from "@/hooks/useCells"
import type { EvenOutResult } from "./even-out"

afterEach(() => vi.useRealTimers())

const evened = { url: "u", type: "audio", slot: "recording", loudnessLufs: -20, truePeakDb: -6, evenTargetLufs: -16 }
function cellsWith(extra: Record<string, unknown>): CellData[] {
  return [{ id: "c1", attachments: { a: evened, ...extra } }] as unknown as CellData[]
}
const ok = (n: number): EvenOutResult => ({ targetLufs: -16, evened: n, skipped: 0, unmeasured: 0, silent: 0, gone: 0, held: [], failed: 0 })

function setup(cells: () => CellData[], over: Partial<Parameters<typeof createAutoEvenQueue>[0]> = {}) {
  const run = over.run ?? vi.fn(async (takes: readonly unknown[]) => ok(takes.length))
  const q = createAutoEvenQueue({ enabled: true, delayMs: 10, cells, allowed: () => true, ...over, run })
  return { q, run: run as ReturnType<typeof vi.fn> }
}

describe("auto-even", () => {
  it("evens a take this tab just recorded on an evened track", async () => {
    vi.useFakeTimers()
    const { q, run } = setup(() => cellsWith({ b: { url: "u2", type: "audio", slot: "recording" } }))
    q.note([{ cellId: "c1", audioId: "b" }])
    await vi.advanceTimersByTimeAsync(10)
    expect(run).toHaveBeenCalledWith([{ cellId: "c1", audioId: "b" }])
  })

  it("does nothing for a take nobody here touched — a Clear, an Undo or a colleague's change stays as it is", async () => {
    vi.useFakeTimers()
    const { q, run } = setup(() => cellsWith({ cleared: { url: "u3", type: "audio", slot: "recording", loudnessLufs: -22, truePeakDb: -6, evenTargetLufs: null } }))
    await vi.advanceTimersByTimeAsync(100)
    expect(run).not.toHaveBeenCalled()
    q.note([])
    await vi.advanceTimersByTimeAsync(100)
    expect(run).not.toHaveBeenCalled()
  })

  it("gathers the takes of one action into one run", async () => {
    vi.useFakeTimers()
    const { q, run } = setup(() => cellsWith({ b: { url: "u2", type: "audio", slot: "recording" }, c: { url: "u4", type: "audio", slot: "recording" } }))
    q.note([{ cellId: "c1", audioId: "b" }])
    q.note([{ cellId: "c1", audioId: "c" }])
    await vi.advanceTimersByTimeAsync(10)
    expect(run).toHaveBeenCalledOnce()
    expect(run.mock.calls[0][0]).toHaveLength(2)
  })

  it("does not try again this session a take it couldn't measure, or whose write was refused", async () => {
    vi.useFakeTimers()
    const b = { url: "u2", type: "audio", slot: "recording" }
    const { q, run } = setup(() => cellsWith({ b }), { run: vi.fn(async () => ({ ...ok(0), unmeasured: 1, skipped: 1 })) })
    q.note([{ cellId: "c1", audioId: "b" }])
    await vi.advanceTimersByTimeAsync(10)
    q.note([{ cellId: "c1", audioId: "b" }])
    await vi.advanceTimersByTimeAsync(10)
    expect(run).toHaveBeenCalledOnce()
  })

  it("tries a take again once it changes (a new trim)", async () => {
    vi.useFakeTimers()
    let b: Record<string, unknown> = { url: "u2", type: "audio", slot: "recording" }
    const { q, run } = setup(() => cellsWith({ b }), { run: vi.fn(async () => ({ ...ok(0), unmeasured: 1, skipped: 1 })) })
    q.note([{ cellId: "c1", audioId: "b" }])
    await vi.advanceTimersByTimeAsync(10)
    b = { ...b, trimStartMs: 400 }
    q.note([{ cellId: "c1", audioId: "b" }])
    await vi.advanceTimersByTimeAsync(10)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("does nothing without a known role of Contributor or up, or with the switch off", async () => {
    vi.useFakeTimers()
    const cells = () => cellsWith({ b: { url: "u2", type: "audio", slot: "recording" } })
    const a = setup(cells, { allowed: () => false })
    a.q.note([{ cellId: "c1", audioId: "b" }])
    const b = setup(cells, { enabled: false })
    b.q.note([{ cellId: "c1", audioId: "b" }])
    await vi.advanceTimersByTimeAsync(50)
    expect(a.run).not.toHaveBeenCalled()
    expect(b.run).not.toHaveBeenCalled()
  })

  it("stops when disposed", async () => {
    vi.useFakeTimers()
    const { q, run } = setup(() => cellsWith({ b: { url: "u2", type: "audio", slot: "recording" } }))
    q.note([{ cellId: "c1", audioId: "b" }])
    q.dispose()
    await vi.advanceTimersByTimeAsync(50)
    expect(run).not.toHaveBeenCalled()
  })
})

describe("this tab's own take changes", () => {
  it("reach every listener until it unsubscribes", () => {
    const seen: unknown[] = []
    const off = onLocalTakeChange((refs) => seen.push(refs))
    noteLocalTakeChange([{ cellId: "c1", audioId: "b" }])
    off()
    noteLocalTakeChange([{ cellId: "c1", audioId: "x" }])
    expect(seen).toEqual([[{ cellId: "c1", audioId: "b" }]])
  })
})
