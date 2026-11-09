/**
 * AQU-2253 (review, Nov 9), finding 8: "Play runs on to the film's end" (and
 * Play with nothing recorded) hangs on one equality. The ids the workspace
 * names with the film (`programmeFilmFor`) must be exactly the ids of the list
 * each caller starts the queue with: the bottom strip, Space, and a click on
 * the timeline. If one list ever differs by a line the feature switches
 * itself off without a sign: Play ends with the lines again and, with nothing
 * recorded, does nothing. Nothing held that.
 *
 * Two halves, because nothing renders ProjectWorkspace in tests:
 *  - the lists, built by the same helpers the workspace builds them with, are
 *    handed to the REAL queue the way each caller hands them over, on a file
 *    with nothing recorded: there the film runs only if the list is the
 *    film's, and with any other list Play does nothing;
 *  - the workspace and the strip are read to check they still take their
 *    lists from those helpers.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { renderHook } from "@testing-library/react"
import {
  getQueueProgress,
  getQueueState,
  resumeQueue,
  setProgrammeFilm,
  setQueueTimingMode,
  startQueue,
  startQueueAtTime,
  stopQueue,
  useProgrammeFilmEndSec,
  type PlayContext,
} from "@/lib/audio/play-queue"
import { mergeCellsWithAudio } from "@/hooks/useFileAudioAttachments"
import { programmeFilmFor, stripLinesFor } from "@/lib/timeline/film-pieces"
import { recordingsLines } from "@/lib/timeline/programme"
import { resetSkipSilentLinesPrefCacheForTests } from "@/lib/store/skip-silent-lines-pref"
import type { CellData } from "@/hooks/useCells"

const FILM_SEC = 600

/** A line with words and nothing recorded. */
const line = (id: string): CellData =>
  ({ id, fileId: "f1", original: `${id} words`, translated: "", medium: "text", attachments: {} }) as unknown as CellData

const ctxFor = (cells: CellData[]): PlayContext => ({
  cells,
  projectId: "p1",
  session: { jwt: "t", username: "dev", createdAt: "" } as PlayContext["session"],
})

/**
 * The lists as ProjectWorkspace builds them. `plain` is the file's lines from
 * the store (`legacyCells`), `merged` the same lines with their audio
 * (`audioMergedCells`), `timeline` the timeline's lines (`timelineCells`: all
 * of them, or fewer on a book), `heard` the file's audio cue lines where its
 * takes live on those (`audioCueCells`).
 */
function workspaceLists(over: { timelineIds?: string[]; heard?: CellData[] | null } = {}) {
  const plain = [line("l1"), line("l2"), line("l3")]
  // Other objects, the same lines: what merging the file's audio in gives.
  const merged = plain.map((c) => ({ ...c }))
  const timeline = over.timelineIds ? merged.filter((c) => over.timelineIds!.includes(c.id)) : merged
  const playback = recordingsLines(timeline, over.heard ?? null, true)
  return {
    plain,
    /** What Space and a click on the timeline start the queue with. */
    playback,
    /** What the bottom strip is handed… */
    strip: stripLinesFor(playback, timeline, merged, plain),
    /** …and the word the workspace gives the queue about the film. */
    film: programmeFilmFor(FILM_SEC, playback),
  }
}

/** What the strip does with the lines it is handed (VoicePlaybackBar). */
const asTheStripStartsIt = (handed: CellData[]) => mergeCellsWithAudio(handed, new Map())

const filmIsRunning = () => getQueueState().kind === "playing" && getQueueProgress().filmClock === true

const CASES: [string, () => ReturnType<typeof workspaceLists>][] = [
  ["a file's own lines", () => workspaceLists()],
  ["a file that plays its heard lines", () => workspaceLists({ heard: [line("h1"), line("h2")] })],
  ["a timeline that draws only some of the file's lines", () => workspaceLists({ timelineIds: ["l1", "l3"] })],
]

beforeEach(() => {
  localStorage.removeItem("aq.skip-silent-lines.v1")
  resetSkipSilentLinesPrefCacheForTests()
  setQueueTimingMode("audioFirst")
})

afterEach(() => {
  stopQueue()
  setProgrammeFilm(null)
  setQueueTimingMode("dubbing")
})

describe("the film's lines are the lines each caller starts the queue with (AQU-2253)", () => {
  for (const [name, lists] of CASES) {
    describe(name, () => {
      it("the bottom strip's Play runs the film, and the strip is offered Play", () => {
        const { strip, film } = lists()
        setProgrammeFilm(film, "f1")
        const cells = asTheStripStartsIt(strip)
        const offered = renderHook(() => useProgrammeFilmEndSec(new Set(cells.map((c) => c.id))))
        expect(offered.result.current).toBe(FILM_SEC)
        startQueue(ctxFor(cells), 0, false)
        expect(filmIsRunning()).toBe(true)
      })

      it("Space runs the film, from the start and from a selected line", () => {
        const { playback, film } = lists()
        setProgrammeFilm(film, "f1")
        startQueueAtTime(ctxFor(playback), 0, { play: true })
        expect(filmIsRunning()).toBe(true)
        stopQueue()
        startQueue(ctxFor(playback), 1, true)
        expect(filmIsRunning()).toBe(true)
      })

      it("a click on the timeline, then Play, runs the film from there", async () => {
        const { playback, film } = lists()
        setProgrammeFilm(film, "f1")
        startQueueAtTime(ctxFor(playback), 2, { play: false })
        expect(getQueueState().kind).toBe("paused")
        await resumeQueue()
        expect(filmIsRunning()).toBe(true)
      })
    })
  }

  it("a list that differs by one line switches it all off: this is what the wiring must never do", () => {
    const { plain, playback, film } = workspaceLists()
    setProgrammeFilm(film, "f1")
    // One line more than the film was named with.
    const drifted = [...plain, line("l4")]
    const offered = renderHook(() => useProgrammeFilmEndSec(new Set(drifted.map((c) => c.id))))
    expect(offered.result.current).toBeNull()
    startQueue(ctxFor(drifted), 0, false)
    expect(getQueueState().kind).toBe("idle")
    // One line fewer.
    startQueueAtTime(ctxFor(playback.slice(1)), 0, { play: true })
    expect(getQueueState().kind).toBe("idle")
  })
})

describe("the workspace and the strip take their lists from those helpers (AQU-2253)", () => {
  const workspace = readFileSync(join(__dirname, "ProjectWorkspace.tsx"), "utf8")
  const strip = readFileSync(join(__dirname, "voice", "VoicePlaybackBar.tsx"), "utf8")

  function callbackBody(source: string, name: string): string {
    const marker = `const ${name} = useCallback(`
    const start = source.indexOf(marker)
    expect(start, name).toBeGreaterThan(-1)
    const next = source.indexOf("\n  const ", start + marker.length)
    return source.slice(start, next === -1 ? undefined : next)
  }

  it("the film is named with the lines Play plays, and for the file on screen", () => {
    expect(workspace).toContain("() => programmeFilmFor(filmRunOnSec, playbackCells),")
    expect(workspace).toContain("setProgrammeFilm(programmeFilm, programmeFilmFileId)")
  })

  it("Space and a click on the timeline start the queue with those lines, and no others", () => {
    for (const name of ["handleTimelineTogglePlay", "handleTimelineSeekToTime"] as const) {
      const body = callbackBody(workspace, name)
      const lists = [...body.matchAll(/\bcells:\s*([A-Za-z0-9_.]+)/g)].map((m) => m[1])
      expect(lists.length, name).toBeGreaterThan(0)
      expect(new Set(lists), name).toEqual(new Set(["playbackCells"]))
      expect(body, name).toMatch(/startQueueAtTime\(/)
    }
  })

  it("the bottom strip is handed those lines", () => {
    expect(workspace).toContain("() => stripLinesFor(playbackCells, timelineCells, audioMergedCells, legacyCells),")
    expect(workspace).toMatch(/<VoicePlaybackBar\s+variant="strip"\s+(?:\/\/[^\n]*\s+)*cells=\{timelineBarCells\}/)
  })

  it("the strip starts the queue with the lines it was handed, and asks about the film for the same ones", () => {
    expect(strip).toContain("() => mergeCellsWithAudio(rawCells, audioByCellId),")
    expect(strip).toContain("const cellIds = useMemo(() => new Set(cells.map((c) => c.id)), [cells])")
    expect(strip).toContain("const filmEndSec = useProgrammeFilmEndSec(cellIds)")
    expect(strip).toContain("startQueue({ cells, projectId, session,")
  })

  it("merging a line's audio in never changes which lines they are", () => {
    const lines = [line("l1"), line("l2")]
    const audio = new Map([["l2", { attachments: {} }]]) as unknown as Parameters<typeof mergeCellsWithAudio>[1]
    expect(mergeCellsWithAudio(lines, audio).map((c) => c.id)).toEqual(["l1", "l2"])
  })
})
