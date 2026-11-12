// AQU-2375: a run where some rows failed never ends on a flat success.

import { describe, expect, it } from "vitest"
import type { TranscribeRunReport } from "./batch-audio"
import { transcribeRunProgressTitle, transcribeRunToast } from "./transcribe-report"

const report = (over: Partial<TranscribeRunReport>): TranscribeRunReport => ({
  total: 45, transcribed: 45, failed: [], notRun: 0, cancelled: false, started: true, ...over,
})
const failures = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ cellId: `c${i}`, message: "HTTP 500" }))

describe("transcribeRunToast", () => {
  it("says nothing when nothing ran", () => {
    expect(transcribeRunToast(report({ started: false, total: 0, transcribed: 0 }), { kind: "all" })).toBeNull()
  })

  it("says plain success only when every row landed", () => {
    expect(transcribeRunToast(report({}), { kind: "import", fileName: "Session 4.mp3" })).toEqual({
      type: "success",
      title: 'Transcribed 45 sections of "Session 4.mp3".',
    })
    expect(transcribeRunToast(report({ total: 1, transcribed: 1 }), { kind: "all" })!.title).toBe("Transcribed 1 recording.")
  })

  it("counts what landed and what did not when some rows failed, with a Retry for those", () => {
    const said = transcribeRunToast(report({ transcribed: 41, failed: failures(4) }), { kind: "import", fileName: "Session 4.mp3" })
    expect(said).toEqual({
      type: "error",
      title: 'Transcribed 41 of 45 sections of "Session 4.mp3".',
      description: "4 couldn't be transcribed. The first one said: HTTP 500",
      retryLabel: "Retry the 4",
    })
  })

  it("names a single failure plainly", () => {
    const said = transcribeRunToast(report({ total: 3, transcribed: 2, failed: failures(1) }), { kind: "all" })
    expect(said!.title).toBe("Transcribed 2 of 3 recordings.")
    expect(said!.description).toBe("1 couldn't be transcribed: HTTP 500")
    expect(said!.retryLabel).toBe("Retry 1")
  })

  it("says a run where nothing landed failed, with its reason", () => {
    const said = transcribeRunToast(report({ transcribed: 0, failed: failures(45) }), { kind: "import", fileName: "Session 4.mp3" })
    expect(said!.type).toBe("error")
    expect(said!.title).toBe('Couldn\'t transcribe "Session 4.mp3": HTTP 500')
    expect(said!.retryLabel).toBe("Retry the 45")
  })

  it("never says success when rows were left undone, even with none failed", () => {
    const said = transcribeRunToast(report({ transcribed: 40, notRun: 5 }), { kind: "all" })
    expect(said!.type).not.toBe("success")
    expect(said!.title).toBe("Transcribed 40 of 45 recordings.")
  })

  // Sam, Nov 12: one closing message, this one, with the file menu build's
  // reasons added (AQU-2521): a run that counts the rows whose audio held no
  // speech says how many, and does not count them as transcribed.
  it("says how many had nothing to transcribe, and leaves them out of the count", () => {
    expect(transcribeRunToast(report({ total: 12, transcribed: 12, heardNothing: 3 }), { kind: "all" })).toEqual({
      type: "info",
      title: "Transcribed 9 of 12 recordings.",
      description: "3 had nothing to transcribe.",
    })
    expect(transcribeRunToast(report({ transcribed: 45, heardNothing: 1 }), { kind: "import", fileName: "Session 4.mp3" })).toEqual({
      type: "info",
      title: 'Transcribed 44 of 45 sections of "Session 4.mp3".',
      description: "1 had nothing to transcribe.",
    })
  })

  it("gives every reason it knows in one line, nothing heard first, with the Retry for the failed", () => {
    const said = transcribeRunToast(report({ total: 12, transcribed: 10, heardNothing: 3, failed: failures(2) }), { kind: "all" })
    expect(said).toEqual({
      type: "error",
      title: "Transcribed 7 of 12 recordings.",
      description: "3 had nothing to transcribe. 2 couldn't be transcribed. The first one said: HTTP 500",
      retryLabel: "Retry the 2",
    })
  })

  it("a stopped run counts only what it transcribed, and says what had nothing", () => {
    const said = transcribeRunToast(report({ transcribed: 20, heardNothing: 1, notRun: 25, cancelled: true }), { kind: "all" })
    expect(said!.title).toBe("Transcription stopped — 19 of 45 done.")
    expect(said!.description).toBe("1 had nothing to transcribe.")
  })

  it("says a cancelled run stopped, and still counts its failures", () => {
    const said = transcribeRunToast(report({ transcribed: 20, failed: failures(2), notRun: 23, cancelled: true }), { kind: "all" })
    expect(said!.type).toBe("info")
    expect(said!.title).toBe("Transcription stopped — 20 of 45 done.")
    expect(said!.description).toBe("2 couldn't be transcribed. The first one said: HTTP 500")
  })
})

describe("transcribeRunProgressTitle", () => {
  it("says what is starting, then counts", () => {
    expect(transcribeRunProgressTitle({ kind: "import", fileName: "a.mp3", done: 0, total: 3, first: true }))
      .toBe('Transcribing 3 sections of "a.mp3"…')
    expect(transcribeRunProgressTitle({ kind: "all", done: 1, total: 3, first: false }))
      .toBe("Transcribing — 1 of 3 done…")
  })

  it("says a run was carried on after a reload, and how far it had got", () => {
    expect(transcribeRunProgressTitle({ kind: "import", fileName: "a.mp3", done: 120, total: 300, first: true, carriedOn: true }))
      .toBe('Carrying on transcribing "a.mp3" after the page reloaded — 120 of 300 done…')
  })
})
