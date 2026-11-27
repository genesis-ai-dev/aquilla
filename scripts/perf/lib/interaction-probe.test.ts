import { describe, expect, it } from "vitest"
import { summarizePhase, type ProbeReading } from "./interaction-probe"

const reading = (log: ProbeReading["react"]["log"]): ProbeReading => ({
  longTasks: [],
  events: [],
  frames: [],
  responses: [],
  react: { commits: log.length, renders: {}, fibers: log.reduce((sum, [, n]) => sum + n, 0), log },
  longTaskUnsupported: false,
})

describe("summarizePhase commitLog", () => {
  // The log exists to diff two runs of one phase commit by commit (PERF-BACKLOG item 37), so
  // its times must not depend on when the page happened to load.
  it("times each commit from the phase's first commit, so two runs line up", () => {
    const early = summarizePhase("open", reading([[1_000, 900, "App"], [1_250, 40, "EditorRow"]]), { count: 0, bytes: 0, byRoute: {} })
    const late = summarizePhase("open", reading([[9_000, 900, "App"], [9_250, 40, "EditorRow"]]), { count: 0, bytes: 0, byRoute: {} })
    expect(early.commitLog).toEqual([[0, 900, "App"], [250, 40, "EditorRow"]])
    expect(late.commitLog).toEqual(early.commitLog)
  })

  it("keeps a commit whose topmost rendered component could not be named", () => {
    const phase = summarizePhase("commit", reading([[5, 3, null]]), { count: 0, bytes: 0, byRoute: {} })
    expect(phase.commitLog).toEqual([[0, 3, null]])
    expect(phase.componentRenders).toBe(3)
  })
})
