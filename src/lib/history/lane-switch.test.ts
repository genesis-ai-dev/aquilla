// Decision 11, gaps 24 and 29: undoing a step made in another language opens
// that language first, unless the person can no longer work in it.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it, expect, vi, afterEach } from "vitest"
import { laneAccessFor, laneShownReady, stepReadsRecordings, waitUntilReady } from "./lane-switch"

const base = { available: ["", "sw", "fr"], scoped: null, archived: [], canSwitch: true, loaded: true }

describe("opening a step's language", () => {
  it("opens any language the switcher offers", () => {
    expect(laneAccessFor("sw", base)).toBe("ok")
  })

  it("drops the step when the language was removed, archived, or is outside the person's limit", () => {
    expect(laneAccessFor("de", base)).toBe("denied")
    expect(laneAccessFor("sw", { ...base, archived: ["sw"] })).toBe("denied")
    expect(laneAccessFor("fr", { ...base, scoped: ["sw"], canSwitch: false })).toBe("denied")
    expect(laneAccessFor("sw", { ...base, scoped: ["sw"], canSwitch: false })).toBe("ok")
  })

  // Review, Oct 29: Cmd+Z pressed as the project opens, before its languages
  // have loaded, must not throw away a step made in French.
  it("keeps the step waiting while the project's languages are still loading", () => {
    expect(laneAccessFor("fr", { ...base, available: [""], loaded: false })).toBe("blocked")
  })

  it("keeps the step waiting for someone who cannot switch languages here", () => {
    expect(laneAccessFor("fr", { ...base, canSwitch: false })).toBe("blocked")
  })
})

// Review, Oct 29: the line store re-sorts its rows for a new language one
// effect pass after the switcher changes, and the loaded flags of a read that
// isn't running say "loaded" for any language. Neither may count until the
// rows are sorted for the language asked for.
describe("the language is on screen", () => {
  it("only once the lines are sorted for it, not on flags left from the one before", () => {
    expect(laneShownReady("fr", { open: "fr", storeLane: "sw", loaded: true })).toBe(false)
    expect(laneShownReady("fr", { open: "fr", storeLane: "fr", loaded: false })).toBe(false)
    expect(laneShownReady("fr", { open: "fr", storeLane: "fr", loaded: true })).toBe(true)
  })
})

describe("waiting for the language to load", () => {
  afterEach(() => vi.useRealTimers())

  it("is ready once the language has loaded on two checks in a row", async () => {
    vi.useFakeTimers()
    let loaded = false
    const done = waitUntilReady(() => loaded, 1000, 50)
    await vi.advanceTimersByTimeAsync(100)
    loaded = true
    await vi.advanceTimersByTimeAsync(100)
    await expect(done).resolves.toBe("ready")
  })

  it("gives up and keeps the step when it never loads", async () => {
    vi.useFakeTimers()
    const done = waitUntilReady(() => false, 300, 50)
    await vi.advanceTimersByTimeAsync(400)
    await expect(done).resolves.toBe("blocked")
  })
})

// AQU-2426 (review, Nov 9, finding 3): opening a language waits for its
// recordings only for a step that reads them. A text edit in the Text view,
// where neither of the workspace's other audio reads loads, waited for them
// too, and on a slow connection was refused after 15 s for want of
// recordings it never needed.
describe("waiting for the language's recordings", () => {
  afterEach(() => vi.useRealTimers())

  it("only a step that reads recordings waits for them", () => {
    for (const kind of ["take.add", "take.window", "take.select", "take.remove", "vote.audio", "lines.split", "track.patch"]) {
      expect(stepReadsRecordings([kind]), kind).toBe(true)
    }
    for (const kind of ["text.commit", "vote.text", "source.text", "cell.label", "row.retime", "row.add", "row.remove", "row.hidden", "lines.fromRecording", "file.importRecording", "film.link", "cue.link", "cast.assign", "settings.project"]) {
      expect(stepReadsRecordings([kind]), kind).toBe(false)
    }
    // A group of steps waits when any of them does.
    expect(stepReadsRecordings(["text.commit", "row.add"])).toBe(false)
    expect(stepReadsRecordings(["text.commit", "take.select"])).toBe(true)
  })

  it("the language is on screen for a text edit while its recordings are still loading", () => {
    const shown = { open: "fr", storeLane: "fr", loaded: true, recordingsLoaded: false }
    expect(laneShownReady("fr", shown, stepReadsRecordings(["text.commit"]))).toBe(true)
    expect(laneShownReady("fr", shown, stepReadsRecordings(["take.select"]))).toBe(false)
    expect(laneShownReady("fr", { ...shown, recordingsLoaded: true }, stepReadsRecordings(["take.select"]))).toBe(true)
  })

  it("a text edit is never refused for recordings that never load; a take step waits and is kept", async () => {
    vi.useFakeTimers()
    const shown = { open: "fr", storeLane: "fr", loaded: true, recordingsLoaded: false }
    const text = waitUntilReady(() => laneShownReady("fr", shown, stepReadsRecordings(["text.commit"])))
    const take = waitUntilReady(() => laneShownReady("fr", shown, stepReadsRecordings(["take.select"])))
    await vi.advanceTimersByTimeAsync(16_000)
    await expect(text).resolves.toBe("ready")
    await expect(take).resolves.toBe("blocked")
  })

  it("pins the workspace: the switcher waits for recordings only when the step reads them", () => {
    const source = readFileSync(join(__dirname, "..", "..", "components", "ProjectWorkspace.tsx"), "utf8")
    const ready = source.slice(source.indexOf("laneReadyRef.current = {"), source.indexOf("// Read through a ref: the switch may first wait"))
    expect(ready).not.toMatch(/ready: [^\n]*audioValidationLoaded/)
    expect(ready).toMatch(/recordingsLoaded: audioValidationLoaded && audioValidationAnswered/)
    const switcher = source.slice(source.indexOf("laneSwitchRef.current = async"), source.indexOf("setLaneSwitcher((lane"))
    expect(switcher).toMatch(/stepReadsRecordings\(kinds\)/)
  })
})
