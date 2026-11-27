// AQU-2375: a run where some rows failed never ends on a flat success.

import { describe, expect, it, vi } from "vitest"
import type { CellData } from "@/hooks/useCells"
import type { TranscribeRunReport } from "./batch-audio"
import { endTranscribeRunToast, transcribeRunProgressTitle, transcribeRunToast } from "./transcribe-report"

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

  // The review (Nov 12), N6: a quiet run (the selected sections, which never
  // had a toast) stays quiet unless something failed: a section that held
  // only music, a stop or a row not reached says nothing there.
  it("a quiet run says nothing unless a row failed", () => {
    expect(transcribeRunToast(report({ total: 3, transcribed: 3, heardNothing: 1 }), { kind: "sections", quiet: true })).toBeNull()
    expect(transcribeRunToast(report({ transcribed: 20, notRun: 25, cancelled: true }), { kind: "sections", quiet: true })).toBeNull()
    expect(transcribeRunToast(report({ total: 3, transcribed: 2, failed: failures(1) }), { kind: "sections", quiet: true }))
      .toMatchObject({ type: "error", retryLabel: "Retry 1" })
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

// The check of the q44 fixes (Nov 12), NOTE D: the end of a run says its last
// word in the run's progress toast, or, with nothing to say (a quiet run that
// went well, carried on after a reload so it had a progress toast), closes
// that toast. It was left spinning for good.
describe("endTranscribeRunToast", () => {
  const toasts = () => ({ add: vi.fn(() => "new"), update: vi.fn(), close: vi.fn() })

  it("a quiet run with nothing to say closes its progress toast", () => {
    const t = toasts()
    endTranscribeRunToast(report({ total: 3, transcribed: 3 }), { kind: "sections", quiet: true, progressToastId: "p1" }, t, () => {})
    expect(t.close).toHaveBeenCalledWith("p1")
    expect(t.update).not.toHaveBeenCalled()
    expect(t.add).not.toHaveBeenCalled()
  })

  it("says its last word in the progress toast, with a Retry for the rows that failed", () => {
    const t = toasts()
    const retry = vi.fn()
    const failed = [{ cellId: "c0", message: "HTTP 500", cell: { id: "c0" } as CellData }]
    endTranscribeRunToast(report({ total: 3, transcribed: 2, failed }), { kind: "all", progressToastId: "p1" }, t, retry)
    expect(t.close).not.toHaveBeenCalled()
    const [id, content] = t.update.mock.calls[0] as unknown as [string, { title: string; actionProps?: { children: string; onClick(): void } }]
    expect(id).toBe("p1")
    expect(content.title).toBe("Transcribed 2 of 3 recordings.")
    content.actionProps!.onClick()
    expect(retry).toHaveBeenCalledWith([failed[0]!.cell])
  })

  it("with no progress toast, a run that has something to say adds one, and one with nothing says nothing", () => {
    const t = toasts()
    endTranscribeRunToast(report({}), { kind: "all", progressToastId: null }, t, () => {})
    expect(t.add).toHaveBeenCalledOnce()
    const quiet = toasts()
    endTranscribeRunToast(report({}), { kind: "sections", quiet: true, progressToastId: null }, quiet, () => {})
    expect(quiet.add).not.toHaveBeenCalled()
    expect(quiet.close).not.toHaveBeenCalled()
  })
})
