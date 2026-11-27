import { describe, expect, it } from "vitest"
import { getTranscribeStatus, waitAtTranscribeLimit } from "./transcribe-status"

describe("waitAtTranscribeLimit (AQU-2426)", () => {
  it("shows the take waiting at the limit, waits the time asked, then carries on", async () => {
    const waited: number[] = []
    let release!: () => void
    const wait = waitAtTranscribeLimit("take-1", (ms) => {
      waited.push(ms)
      return new Promise<void>((r) => { release = r })
    })
    const done = wait(42)
    expect(getTranscribeStatus("take-1")).toEqual({ kind: "transcribing", waiting: "limit" })
    expect(waited).toEqual([42_000])
    release()
    await done
    expect(getTranscribeStatus("take-1")).toEqual({ kind: "transcribing" })
  })
})
