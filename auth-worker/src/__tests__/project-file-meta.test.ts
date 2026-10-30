import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { loadFilesByProject } from "../routes/projects"

// The file-meta projection, tested directly for the first time. (AQU-646)
//
// Twice now a field has been lost in this exact spot with nothing to notice:
// the client mapped it, no route produced it, and the feature it fed was
// silently dead — coreMediaUrl (the video pane, dead on every cold load) and
// then audioVttTimebase (the project report claiming "no record of a timing
// check" about episodes the import had in fact corrected). Both bugs were
// found from their symptoms, weeks apart. This seeds a row carrying every
// meta-derived field and asserts each one comes back out.

async function seed(fileId: string, meta: unknown): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO files (id, project_id, name, kind, role, event_id, cell_count, approved_count, word_count, meta)
     VALUES (?, 'proj-meta-test', ?, 'vtt', 'audio-cues', ?, 0, 0, 0, ?)`,
  )
    .bind(fileId, fileId, `evt-${fileId}`, JSON.stringify(meta))
    .run()
}

const STUDY_NOTES_STAMP = { aquillaImport: { profileId: "builtin:biblica-study-notes" } }

async function seedSourceCell(fileId: string, cellId: string, metadata: unknown): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at, lane_id, metadata)
     VALUES ('proj-meta-test', ?, ?, 'source', 'In the beginning', ?, 0, (SELECT aquilla_test_resolve_source_lane('proj-meta-test')), ?)`,
  )
    .bind(fileId, cellId, `evt-${cellId}`, JSON.stringify(metadata))
    .run()
}

describe("what files.meta projects into a file summary", () => {
  it("forwards the timing correction the audio-VTT import recorded", async () => {
    await seed("meta-tb-full", {
      orderedBy: "time",
      aquillaImport: { audioVtt: { timebase: { fromFps: "24", toFps: "23.976", scale: 1.001 } } },
    })
    const byProject = await loadFilesByProject(env, ["proj-meta-test"])
    const file = byProject.get("proj-meta-test")!.find((f) => f.id === "meta-tb-full")!
    expect(file.audioVttTimebase).toEqual({ fromFps: "24", toFps: "23.976", scale: 1.001 })
  })

  it("forwards a scale-only record — the labels are optional by design", async () => {
    // A drift measured from the words is exact even when neither frame rate
    // could be named; 24-against-23.976 and 30-against-29.97 are the same ratio.
    await seed("meta-tb-bare", {
      aquillaImport: { audioVtt: { timebase: { scale: 1.001 } } },
    })
    const byProject = await loadFilesByProject(env, ["proj-meta-test"])
    const file = byProject.get("proj-meta-test")!.find((f) => f.id === "meta-tb-bare")!
    expect(file.audioVttTimebase).toEqual({ scale: 1.001 })
  })

  it("omits it entirely when there is no usable record", async () => {
    await seed("meta-tb-none", { orderedBy: "time" })
    await seed("meta-tb-junk", { aquillaImport: { audioVtt: { timebase: { scale: "1.001" } } } })
    const byProject = await loadFilesByProject(env, ["proj-meta-test"])
    const files = byProject.get("proj-meta-test")!
    expect(files.find((f) => f.id === "meta-tb-none")!.audioVttTimebase).toBeUndefined()
    expect(files.find((f) => f.id === "meta-tb-junk")!.audioVttTimebase).toBeUndefined()
  })

  it("forwards an extension's display label (AQU-1937), and drops an invalid one", async () => {
    await seed("meta-ext-label", { extension: { kind: "normal", tags: ["door43"], label: "Titus · ULT" } })
    await seed("meta-ext-bad", { extension: { kind: "normal", tags: [], label: "x\ny" } })
    const files = (await loadFilesByProject(env, ["proj-meta-test"])).get("proj-meta-test")!
    const labelled = files.find((f) => f.id === "meta-ext-label")!
    expect(labelled.displayLabel).toBe("Titus · ULT")
    // The stored name is untouched.
    expect(labelled.name).toBe("meta-ext-label")
    expect(files.find((f) => f.id === "meta-ext-bad")!.displayLabel).toBeUndefined()
  })

  it("still forwards the rest of the meta-derived fields beside it", async () => {
    // The regression this file exists to prevent is a NEW field silently
    // starving an old one — so pin the neighbours too.
    await seed("meta-kitchen-sink", {
      orderedBy: "time",
      coreMediaUrl: "https://cdn.example/master.m3u8",
      timingMode: "dubbing",
      aquillaImport: { audioVtt: { timebase: { scale: 1.001 } } },
    })
    const byProject = await loadFilesByProject(env, ["proj-meta-test"])
    const file = byProject.get("proj-meta-test")!.find((f) => f.id === "meta-kitchen-sink")!
    expect(file.coreMediaUrl).toBe("https://cdn.example/master.m3u8")
    expect(file.timingMode).toBe("dubbing")
    expect(file.orderedBy).toBe("time")
    expect(file.audioVttTimebase).toEqual({ scale: 1.001 })
  })

  it("forwards an explicit corpusMarker so sidebar folders survive reload", async () => {
    await seed("meta-corpus", { corpusMarker: "Treasure Hunt Bible" })
    const byProject = await loadFilesByProject(env, ["proj-meta-test"])
    const file = byProject.get("proj-meta-test")!.find((f) => f.id === "meta-corpus")!
    expect(file.corpusMarker).toBe("Treasure Hunt Bible")
  })

  it("recovers a Biblica folder from parserVersion when corpusMarker was never stored", async () => {
    await seed("meta-thb-legacy", { parserVersion: "builtin:biblica-treasure-hunt@1" })
    await seed("meta-r4l-legacy", { parserVersion: "builtin:biblica-reach4life@1" })
    const byProject = await loadFilesByProject(env, ["proj-meta-test"])
    const files = byProject.get("proj-meta-test")!
    expect(files.find((f) => f.id === "meta-thb-legacy")!.corpusMarker).toBe("Treasure Hunt Bible")
    expect(files.find((f) => f.id === "meta-thb-legacy")!.importProfile).toBe("builtin:biblica-treasure-hunt")
    expect(files.find((f) => f.id === "meta-r4l-legacy")!.corpusMarker).toBe("Reach 4 Life")
    expect(files.find((f) => f.id === "meta-r4l-legacy")!.importProfile).toBe("builtin:biblica-reach4life")
  })

  it("recovers a Biblica profile from a source cell when files.meta never recorded one", async () => {
    await seed("meta-from-cell", {})
    await seed("meta-from-cell-moved", { corpusMarker: "My Notes" })
    for (const fileId of ["meta-from-cell", "meta-from-cell-moved"]) {
      await seedSourceCell(fileId, `cell-${fileId}`, STUDY_NOTES_STAMP)
    }
    const byProject = await loadFilesByProject(env, ["proj-meta-test"], { recoverCellProfiles: true })
    const files = byProject.get("proj-meta-test")!
    const recovered = files.find((f) => f.id === "meta-from-cell")!
    expect(recovered.importProfile).toBe("builtin:biblica-study-notes")
    expect(recovered.corpusMarker).toBe("Biblica Study Notes")
    const moved = files.find((f) => f.id === "meta-from-cell-moved")!
    expect(moved.importProfile).toBe("builtin:biblica-study-notes")
    expect(moved.corpusMarker).toBe("My Notes")
  })

  it("finds the profile past a hand-added source cell that sorts ahead of the imported ones", async () => {
    await seed("meta-from-cell-added", {})
    await seedSourceCell("meta-from-cell-added", "a-hand-added", { note: "typed in the editor" })
    await seedSourceCell("meta-from-cell-added", "b-imported", STUDY_NOTES_STAMP)
    const files = (await loadFilesByProject(env, ["proj-meta-test"], { recoverCellProfiles: true })).get("proj-meta-test")!
    expect(files.find((f) => f.id === "meta-from-cell-added")!.importProfile).toBe("builtin:biblica-study-notes")
  })

  it("leaves cells alone for the project list (AQU-2281)", async () => {
    // GET /api/v2/projects serves session boot across every accessible
    // project. Reading cells there for legacy profiles cost it 30–90 s; the
    // open workspace gets the recovered profile from the single-project route.
    await seed("meta-list-cell-only", {})
    await seedSourceCell("meta-list-cell-only", "cell-meta-list-cell-only", STUDY_NOTES_STAMP)
    const files = (await loadFilesByProject(env, ["proj-meta-test"])).get("proj-meta-test")!
    const file = files.find((f) => f.id === "meta-list-cell-only")!
    expect(file.importProfile).toBeUndefined()
    expect(file.corpusMarker).toBeUndefined()
  })

  it("prefers the stored corpusMarker over a Biblica parserVersion backfill", async () => {
    await seed("meta-moved", {
      corpusMarker: "My Notes",
      parserVersion: "builtin:biblica-study-notes@1",
    })
    const byProject = await loadFilesByProject(env, ["proj-meta-test"])
    const file = byProject.get("proj-meta-test")!.find((f) => f.id === "meta-moved")!
    expect(file.corpusMarker).toBe("My Notes")
    expect(file.importProfile).toBe("builtin:biblica-study-notes")
  })
})
