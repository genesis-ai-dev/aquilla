/**
 * AQU-2253 (review, Nov 9), finding 8: "Play runs on to the film's end" (and
 * Play with nothing recorded) hangs on one equality. The ids the workspace
 * names with the film (`programmeFilmFor`) must be exactly the ids of the list
 * each caller starts the queue with: the bottom strip, Space, and a click on
 * the timeline. If one list ever differs by a line the feature switches
 * itself off without a sign: Play ends with the lines again and, with nothing
 * recorded, does nothing. Nothing held that.
 *
 * AQU-2253 (Sam, Nov 9): the film is also the lines' source, so a run whose
 * lines are all the film's file's has the film behind it (a line with nothing
 * of its own plays with the film, never skipped); only a run of the whole list
 * runs on past its lines. On a book the film is named with every chapter's
 * lines. Since the whole-book timeline (dev, Nov 13) a run holds the whole
 * book, so Play runs on past the book's last line to the film's end, as on
 * any other file (the review of the Nov 19 merge, S1).
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
  linesPlaybackStopsAt,
  queuePlaybackAsk,
  useProgrammeFilm,
  type PlayContext,
} from "@/lib/audio/play-queue"
import { mergeCellsWithAudio } from "@/hooks/useFileAudioAttachments"
import { linkedFilmBehindLines, programmeFilmFor, stripLinesFor } from "@/lib/timeline/film-pieces"
import { filmOverRun, recordingsLines } from "@/lib/timeline/programme"
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

/** Two chapters of a book, nothing recorded. */
const BOOK = () => [line("RUT 1:1"), line("RUT 1:2"), line("RUT 2:1"), line("RUT 2:2")]

/**
 * The lists as ProjectWorkspace builds them. `plain` is the file's lines from
 * the store (`legacyCells`), `merged` the same lines with their audio
 * (`audioMergedCells`), `timeline` the timeline's lines (`timelineCells`:
 * since the whole-book timeline, all of them, a book's every chapter too),
 * `heard` the file's audio cue lines where its takes live on those
 * (`audioCueCells`).
 */
function workspaceLists(over: { lines?: CellData[]; heard?: CellData[] | null } = {}) {
  const plain = over.lines ?? [line("l1"), line("l2"), line("l3")]
  // Other objects, the same lines: what merging the file's audio in gives.
  const merged = plain.map((c) => ({ ...c }))
  // `timelineLines`, and the timeline's (`timelineCells`): every line.
  const timeline = merged
  const playback = recordingsLines(timeline, over.heard ?? null, true)
  // The word about the film, as the workspace asks it (`filmBehind`): a book
  // is asked the same as any file.
  const behind = linkedFilmBehindLines({ kind: "linked", paneOnScreen: true, followsRecordings: true, durationSec: FILM_SEC })
  return {
    plain,
    /** What Space and a click on the timeline start the queue with. */
    playback,
    /** What the bottom strip is handed… */
    strip: stripLinesFor(playback, timeline, merged, plain),
    /** …and the word the workspace gives the queue about the film: named
     *  with every line of the file Play plays (`filmLines`). */
    film: programmeFilmFor(behind, playback),
  }
}

/** What the strip does with the lines it is handed (VoicePlaybackBar). */
const asTheStripStartsIt = (handed: CellData[]) => mergeCellsWithAudio(handed, new Map())

const filmIsRunning = () => getQueueState().kind === "playing" && getQueueProgress().filmClock === true

const CASES: [string, () => ReturnType<typeof workspaceLists>][] = [
  ["a file's own lines", () => workspaceLists()],
  ["a file that plays its heard lines", () => workspaceLists({ heard: [line("h1"), line("h2")] })],
  ["a book, every chapter on the timeline", () => workspaceLists({ lines: BOOK() })],
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
        const word = renderHook(() => useProgrammeFilm())
        expect(linesPlaybackStopsAt(cells, { ...queuePlaybackAsk(), freeTiming: true, film: word.result.current }).size).toBeGreaterThan(0)
        // The length the strip shows: the film's, a book's too.
        expect(filmOverRun(word.result.current, cells.map((c) => c.id)).runsOnToSec).toBe(FILM_SEC)
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

  // The review of the Nov 19 merge, S1: a book whose film is longer than its
  // lines. The run holds the whole book, so there is no chapter left for Play
  // to stop at: it runs on past the book's last line to the film's end.
  it("on a book whose film is longer than the book, Play runs on past the last line to the film's end", () => {
    const { playback, film } = workspaceLists({ lines: BOOK() })
    expect(film?.runsOn).toBe(true)
    setProgrammeFilm(film, "f1")
    startQueueAtTime(ctxFor(playback), 0, { play: true })
    expect(filmIsRunning()).toBe(true)
    expect(getQueueProgress().duration).toBe(FILM_SEC)
    expect(filmOverRun(film, playback.map((c) => c.id))).toEqual({ coverSec: FILM_SEC, runsOnToSec: FILM_SEC })
  })

  // AQU-2253 (Sam, Nov 9): one line fewer used to switch it off too. Those
  // lines are all the film's file's, so the film is behind them now; what one
  // line fewer still loses is Play running on past them.
  it("a list one line longer switches it all off, and one line shorter loses the run on: this is what the wiring must never do", () => {
    const { plain, playback, film } = workspaceLists()
    setProgrammeFilm(film, "f1")
    // One line more than the film was named with.
    const drifted = [...plain, line("l4")]
    expect(linesPlaybackStopsAt(drifted, { ...queuePlaybackAsk(), freeTiming: true }).size).toBe(0)
    startQueue(ctxFor(drifted), 0, false)
    expect(getQueueState().kind).toBe("idle")
    // One line fewer: under the film, but it ends with its lines.
    const fewer = playback.slice(1)
    expect(filmOverRun(film, fewer.map((c) => c.id))).toEqual({ coverSec: FILM_SEC, runsOnToSec: 0 })
    startQueueAtTime(ctxFor(fewer), 0, { play: true })
    expect(filmIsRunning()).toBe(true)
    expect(getQueueProgress().duration).toBeLessThan(FILM_SEC)
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

  it("the film is asked of a book as of any file: no 'one chapter of a book' rule (S1)", () => {
    expect(workspace).not.toContain("chapterOfABook")
  })

  it("the film is named with the lines Play plays, and for the file on screen", () => {
    // Every line of the file Play plays. Since dev's whole-book timeline
    // (Nov 13) the timeline's lines are every chapter's (`timelineCells` IS
    // `timelineLines`), so the film's lines are `playbackCells` themselves.
    expect(workspace).toContain("const timelineCells = timelineLines")
    expect(workspace).toContain("() => recordingsLines(timelineCells, audioCueCells, timingMode === \"audioFirst\"),")
    expect(workspace).toContain("const filmLines = playbackCells")
    expect(workspace).toContain("() => programmeFilmFor(filmBehind, filmLines),")
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

  // AQU-2253 (review 2, Nov 9): Play all's own move into the next chapter asks
  // for something of the chapter's own (lib/timeline/chapter-pick's
  // `nextChapterForPlayAll`, play-queue.film-tail.test.ts), never the film.
  it("Play all's move into the next chapter asks the chapter planner, not the film", () => {
    const start = workspace.indexOf("useEffect(() => onQueueRanOut((ctx) => {")
    expect(start).toBeGreaterThan(-1)
    const body = workspace.slice(start, workspace.indexOf("}), [])", start))
    expect(body).toContain("nextChapterForPlayAll({ chapters: run.chapters, lines: run.cells, playedKey: played.key })")
    expect(body).not.toContain("CountingFilm")
  })

  it("the bottom strip is handed those lines", () => {
    expect(workspace).toContain("() => stripLinesFor(playbackCells, timelineCells, audioMergedCells, legacyCells),")
    expect(workspace).toMatch(/<VoicePlaybackBar\s+variant="strip"\s+(?:\/\/[^\n]*\s+)*cells=\{timelineBarCells\}/)
  })

  it("the strip starts the queue with the lines it was handed, and asks about the film for the same ones", () => {
    expect(strip).toContain("() => mergeCellsWithAudio(rawCells, audioByCellId),")
    expect(strip).toContain("const cellIds = useMemo(() => new Set(cells.map((c) => c.id)), [cells])")
    expect(strip).toContain("const film = useProgrammeFilm()")
    expect(strip).toContain("filmOverRun(film, cellIds)")
    expect(strip).toContain("linesPlaybackStopsAt(cells, {\n      freeTiming: filmCounts, ...(programmeTracks ? { tracks: programmeTracks } : {}), film, skipSilent,")
    expect(strip).toContain("startQueue({ cells, projectId, session,")
  })

  it("merging a line's audio in never changes which lines they are", () => {
    const lines = [line("l1"), line("l2")]
    const audio = new Map([["l2", { attachments: {} }]]) as unknown as Parameters<typeof mergeCellsWithAudio>[1]
    expect(mergeCellsWithAudio(lines, audio).map((c) => c.id)).toEqual(["l1", "l2"])
  })
})
