/**
 * AQU-2426 (browser pass, Nov 9): workspace readers of a file's recordings
 * that run in the Text view.
 *
 * The workspace's own audio map is not fetched in the Text view unless the
 * person may restructure lines (by default nobody may). Each reader below ran
 * in the Text view on that empty map, so every line looked as if it had no
 * recording and no generated voice:
 *
 *  - "Generate voices for every line" (⋯ menu) counted the lines that already
 *    have a generated voice, and its run generated them again;
 *  - Export found no recordings on a file whose takes are on its own lines;
 *  - in a language that delivers text, a line with only a recording counted
 *    as untranslated in the status bar, progress and the rule engine;
 *  - Undo of a voice generated from an extension did not put back the voice
 *    the line had before;
 *  - an Undo that opens another language first ran before that language's
 *    recordings had loaded.
 *
 * They now read the lane's own read of the file's recordings (fetched in
 * every view) where the workspace's map does not have the line. The ⋯ menu's
 * "Transcribe all audio" and "Change voice for all" counts are left on the
 * workspace's map: keeping them out of the Text view was Sam's call
 * (AQU-490, Sep 21).
 *
 * The first half runs the readers' own steps on what the Text view has; the
 * second pins the workspace to them, as nothing renders ProjectWorkspace in
 * tests.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { CellData } from "@/hooks/useCells"
import type { CellAudioEntry } from "@/lib/sync/cell-audio-read-types"
import { mergeCellsWithAudio } from "@/hooks/useFileAudioAttachments"
import { resolveSynthTargets } from "@/lib/audio/linked-takes"
import { playingInSlot } from "@/lib/history/take-steps"
import { GENERATED_VOICE_SLOT } from "@/lib/timeline/track-slots"
import { linesWithRecordings } from "./project-workspace-helpers"

const VOICE = "audio-l2-1794271992950-voice.mp3"
const TAKE = "audio-l3-1794271993000-take.webm"

/** Three translated lines, as the store has them: no recordings. */
const storeLines = (): CellData[] =>
  ["l1", "l2", "l3"].map((id) => ({ id, fileId: "f1", original: `Line ${id}.`, translated: `Línea ${id}.`, medium: "text" }) as unknown as CellData)

/** The workspace's audio map in the Text view on a project with default settings: not fetched. */
const TEXT_VIEW_WORKSPACE_MAP = new Map<string, CellAudioEntry>()

/** The lane's read (fetched in every view): a generated voice on line 2, a take on line 3. */
const laneRead = (): Map<string, CellAudioEntry> => new Map([
  ["l2", {
    attachments: { [VOICE]: { audioId: VOICE, url: `frontier-audio://p1/f1/${VOICE}`, slot: GENERATED_VOICE_SLOT, durationMs: 2_000 } },
    selectedBySlot: { [GENERATED_VOICE_SLOT]: VOICE },
    selectedAudioId: null,
    selectedGeneratedVoiceAudioId: VOICE,
    audioTimings: {},
  } as unknown as CellAudioEntry],
  ["l3", {
    attachments: { [TAKE]: { audioId: TAKE, url: `frontier-audio://p1/f1/${TAKE}`, slot: "recording", durationMs: 3_000 } },
    selectedBySlot: { recording: TAKE },
    selectedAudioId: TAKE,
    selectedGeneratedVoiceAudioId: null,
    audioTimings: {},
  } as unknown as CellAudioEntry],
])

const NO_CUES = { cueCells: null, cuesForText: new Map<string, readonly string[]>(), textForCue: new Map<string, readonly string[]>() }

describe("the file's recordings, as the Text view has them", () => {
  it("Generate voices for every line counts only the lines with no voice yet", () => {
    const lines = linesWithRecordings(storeLines(), TEXT_VIEW_WORKSPACE_MAP, laneRead())
    expect(resolveSynthTargets(lines, NO_CUES).map((t) => t.cell.id)).toEqual(["l1", "l3"])
    // What it counted from the workspace's map alone: line 2 again, voiced.
    const before = mergeCellsWithAudio(storeLines(), TEXT_VIEW_WORKSPACE_MAP)
    expect(resolveSynthTargets(before, NO_CUES).map((t) => t.cell.id)).toEqual(["l1", "l2", "l3"])
  })

  it("Export sees the take on its line", () => {
    const l3 = linesWithRecordings(storeLines(), TEXT_VIEW_WORKSPACE_MAP, laneRead()).find((c) => c.id === "l3")!
    expect(l3.selectedAudioId).toBe(TAKE)
    expect(l3.attachments?.[TAKE]?.url).toBe(`frontier-audio://p1/f1/${TAKE}`)
  })

  it("Undo of a generated voice knows the voice the line had before", () => {
    expect(playingInSlot(TEXT_VIEW_WORKSPACE_MAP.get("l2") ?? laneRead().get("l2"), GENERATED_VOICE_SLOT)).toBe(VOICE)
  })

  it("in the Media view the workspace's map is read as before", () => {
    const media = laneRead()
    expect(linesWithRecordings(storeLines(), media, media)).toEqual(mergeCellsWithAudio(storeLines(), media))
    expect(linesWithRecordings(storeLines(), media, new Map())).toEqual(mergeCellsWithAudio(storeLines(), media))
  })
})

describe("pins the workspace to those readers", () => {
  const source = readFileSync(join(__dirname, "ProjectWorkspace.tsx"), "utf8")
  const between = (from: string, to: string) => {
    const at = source.indexOf(from)
    expect(at, from).toBeGreaterThanOrEqual(0)
    return source.slice(at, source.indexOf(to, at))
  }

  it("Generate voices for every line resolves its lines from the lane's recordings", () => {
    const block = between("const synthTargets = useMemo(", "synthTargetsRef.current = synthTargets")
    expect(block).toMatch(/resolveSynthTargets\(textViewAudioCells, cueLinkArgs\)/)
    expect(between("const textViewAudioCells = useMemo(", "const synthTargets"))
      .toMatch(/linesWithRecordings\(readAtVersion\(cellStoreVersion, getActiveCells\), workspaceAudioByCellId, audioValidationByCellId\)/)
  })

  it("Transcribe all audio and Change voice for all still count from the workspace's map (Sam, AQU-490)", () => {
    expect(between("const audioCounts = useMemo(", "}, [activeFileId")).toMatch(/const holders = audioCueCells \?\? batchAudioCells/)
  })

  it("Export's recordings come from the lane's read too", () => {
    expect(source).toMatch(/audioCells=\{audioCueCells \?\? exportAudioCells\}/)
    expect(between("const exportAudioCells = useMemo(", "\n  )\n"))
      .toMatch(/linesWithRecordings\(legacyCells, workspaceAudioByCellId, audioValidationByCellId\)/)
  })

  it("a line with a take of its own is read from the lane's recordings", () => {
    const block = between("const ownTakeCellIds = useMemo(", "}, [")
    expect(block).toMatch(/sharedSelections\(audioValidationByCellId\.values\(\)\)/)
    expect(block).toMatch(/for \(const \[cellId, entry\] of audioValidationByCellId\)/)
  })

  it("an extension's generated voice names the voice before it from the lane's read when the workspace has none", () => {
    expect(source).toMatch(/selectedBefore: playingInSlot\(workspaceAudioByCellIdRef\.current\.get\(cell\.id\) \?\? audioValidationByCellIdRef\.current\.get\(cell\.id\), GENERATED_VOICE_SLOT\)/)
  })

  it("an Undo that opens another language waits for that language's recordings", () => {
    expect(between("laneReadyRef.current = {", "}")).toMatch(/audioValidationLoaded/)
  })
})
