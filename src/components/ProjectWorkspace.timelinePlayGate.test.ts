/**
 * AQU-1752: timeline Space and "Play from this cue" wait until the timeline's
 * `useFileAudioAttachments` read has settled.
 *
 * Before that read, a source clip is not merged in, so the picture or the
 * virtual clock looks like it owns the file. Starting either is the press
 * that goes nowhere once the clip arrives. The same rule VoicePlaybackBar
 * already applies (#1167). The press is dropped; nothing is handed to the
 * queue when the read lands.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { timelinePlayReady } from "./project-workspace-helpers"

const GATE = "if (!timelinePlayReady(timelineAudioLoaded)) return"

function callbackBody(source: string, name: string): string {
  const marker = `const ${name} = useCallback(`
  const start = source.indexOf(marker)
  expect(start, name).toBeGreaterThan(-1)
  const next = source.indexOf("\n  const ", start + marker.length)
  return source.slice(start, next === -1 ? undefined : next)
}

describe("timelinePlayReady (AQU-1752)", () => {
  it("holds play until the file's audio attachments have been read", () => {
    expect(timelinePlayReady(false)).toBe(false)
  })

  it("allows play once that read has settled", () => {
    expect(timelinePlayReady(true)).toBe(true)
  })

  it("gates Space and play-from-cue on the timeline's hasLoaded", () => {
    const source = readFileSync(join(__dirname, "ProjectWorkspace.tsx"), "utf8")
    expect(source).toContain(
      "const { byCellId: timelineAudioByCellId, hasLoaded: timelineAudioLoaded } = useFileAudioAttachments(",
    )
    for (const name of ["handleTimelineTogglePlay", "handleTimelinePlayFromTime"] as const) {
      const body = callbackBody(source, name)
      const gateAt = body.indexOf(GATE)
      expect(gateAt, name).toBeGreaterThan(-1)
      const starts = ["setVideoToggle(", "virtualClockPlay()", "handleTimelineSeekToTime(", "startQueue(", "startQueueAtTime("]
      for (const start of starts) {
        const at = body.indexOf(start)
        if (at === -1) continue
        expect(gateAt, `${name} starts ${start} before the gate`).toBeLessThan(at)
      }
    }
  })
})
