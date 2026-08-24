import { describe, expect, it } from "vitest"

import {
  forgetStallSample,
  IDLE_STALL_STATE,
  stallStep,
  STALL_FROZEN_TICKS,
  STALL_SETTLED_TICKS,
  type StallAction,
  type StallSample,
  type StallState,
} from "./video-stall"

/** A picture the transport wants, claiming to be running. */
const running = (sec: number, over: Partial<StallSample> = {}): StallSample => ({
  sec,
  wantPlay: true,
  paused: false,
  ended: false,
  seeking: false,
  pendingPlay: false,
  ...over,
})

/** Feed a run of samples, collecting every action that was not "none". */
function run(
  samples: StallSample[],
  from: StallState = IDLE_STALL_STATE,
): { state: StallState; actions: StallAction[] } {
  let state = from
  const actions: StallAction[] = []
  for (const s of samples) {
    const step = stallStep(state, s)
    state = step.state
    if (step.action.kind !== "none") actions.push(step.action)
  }
  return { state, actions }
}

/** The clock frozen at one position for `n` samples. */
const frozen = (n: number, at = 12) => Array.from({ length: n }, () => running(at))
/** The clock advancing a second per sample. */
const moving = (n: number, from = 12) => Array.from({ length: n }, (_, i) => running(from + i + 1))

describe("a frozen clock while the element claims to be playing", () => {
  it("says nothing on the first sample — it has no baseline to judge against", () => {
    const { actions } = run([running(12)])
    expect(actions).toEqual([])
  })

  it("waits out an ordinary rebuffer before believing it", () => {
    // One frozen sample is a stutter. The grace exists so a stream that catches
    // up on its own is never touched.
    const { actions } = run([running(12), running(12)].slice(0, STALL_FROZEN_TICKS))
    expect(actions).toEqual([])
  })

  it("nudges once the clock has been frozen through the grace", () => {
    const { actions } = run([...frozen(1 + STALL_FROZEN_TICKS)])
    expect(actions).toEqual([{ kind: "recover", rung: "nudge" }])
  })

  it("climbs the ladder in order, one rung per patience window, then gives up", () => {
    const { actions } = run(frozen(20))
    expect(actions).toEqual([
      { kind: "recover", rung: "nudge" },
      { kind: "recover", rung: "recover" },
      { kind: "recover", rung: "rebuild" },
      { kind: "giveUp" },
    ])
  })

  it("stops trying once it has given up, rather than retrying forever", () => {
    const { actions } = run(frozen(60))
    expect(actions.filter((a) => a.kind === "giveUp")).toHaveLength(1)
    expect(actions).toHaveLength(4)
  })
})

describe("what is not a stall", () => {
  const cases: [string, Partial<StallSample>][] = [
    ["the transport does not want playback", { wantPlay: false }],
    ["the user paused it", { paused: true }],
    ["the film ended", { ended: true }],
    ["a seek is still landing", { seeking: true }],
    ["the readiness gate is holding the start", { pendingPlay: true }],
  ]
  for (const [why, over] of cases) {
    it(`never fires when ${why}`, () => {
      const { actions } = run(Array.from({ length: 30 }, () => running(12, over)))
      expect(actions).toEqual([])
    })
  }

  it("does not read a resumption as motion after a long pause", () => {
    // The baseline is dropped whenever we are not judging, so the first sample
    // back only re-establishes it. Otherwise a pause at 12s followed by a scrub
    // to 400s would look like a very healthy second of playback.
    const paused = run([running(12), running(13), running(13, { paused: true })])
    expect(paused.state.lastSec).toBeNull()
  })
})

describe("leaving a stall", () => {
  it("takes the spinner down on the first sample that moves", () => {
    const { actions } = run([...frozen(3), ...moving(1)])
    expect(actions).toEqual([
      { kind: "recover", rung: "nudge" },
      { kind: "recovered" },
    ])
  })

  it("reports recovery once, not on every moving sample after it", () => {
    const { actions } = run([...frozen(3), ...moving(6)])
    expect(actions.filter((a) => a.kind === "recovered")).toHaveLength(1)
  })

  it("counts a quarter-speed film as motion", () => {
    // 0.25s per sample is real playback, and a threshold that missed it would
    // put a spinner over a film running slowly on purpose.
    const slow = [running(12), running(12.25), running(12.5), running(12.75), running(13)]
    expect(run(slow).actions).toEqual([])
  })
})

describe("the escalation budget", () => {
  it("is NOT reset by the twitch a nudge buys", () => {
    // The whole point. Each rung produces a moment of playback; if that reset
    // the ladder we would nudge-twitch-freeze forever and never reach the rungs
    // that actually work. Two moving samples is less than sustained.
    const twitch = [...frozen(3), ...moving(2, 12), ...frozen(3, 14)]
    const { actions } = run(twitch)
    expect(actions).toEqual([
      { kind: "recover", rung: "nudge" },
      { kind: "recovered" },
      { kind: "recover", rung: "recover" },
    ])
  })

  it("is reset by sustained playback, so a later stall gets the full ladder", () => {
    const settled = [...frozen(3), ...moving(STALL_SETTLED_TICKS, 12), ...frozen(3, 99)]
    const { actions } = run(settled)
    expect(actions).toEqual([
      { kind: "recover", rung: "nudge" },
      { kind: "recovered" },
      // Back to the bottom of the ladder rather than straight to "recover".
      { kind: "recover", rung: "nudge" },
    ])
  })

  it("brings a picture that had given up back into play once it settles", () => {
    const revived = [...frozen(20), ...moving(STALL_SETTLED_TICKS, 12)]
    const { state } = run(revived)
    expect(state.gaveUp).toBe(false)
    expect(state.spent).toBe(0)
  })
})

describe("forgetStallSample", () => {
  it("drops the baseline but keeps the episode's budget", () => {
    const { state } = run(frozen(6))
    const after = forgetStallSample(state)
    // A rebuilt element starts its clock at zero and is then seeked back; the
    // sampler must read neither as evidence.
    expect(after.lastSec).toBeNull()
    expect(after.frozenTicks).toBe(0)
    expect(after.spent).toBe(state.spent)
  })

  it("does not hand the ladder back — a rebuild is not recovery", () => {
    const { state } = run(frozen(6))
    const after = forgetStallSample(state)
    const { actions } = run(frozen(6, 12), after)
    expect(actions).toEqual([{ kind: "recover", rung: "rebuild" }, { kind: "giveUp" }])
  })
})
