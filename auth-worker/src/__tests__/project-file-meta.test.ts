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
})
