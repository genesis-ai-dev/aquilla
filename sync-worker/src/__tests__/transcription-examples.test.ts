// GET /api/v1/projects/:projectId/transcription-examples (Omnilingual ASR spec §2)
//
// Against real Postgres (PGlite) on the canonical schema. What matters:
//  - Only clips the zero-shot model can learn from come back: a human
//    recording of THIS lane's text, 2–30 s of kept audio. A 1 s clip teaches
//    nothing and a 40 s one overflows the model's 30 s context slot.
//  - Validated takes and takes whose source text resembles the cell being
//    transcribed come first — they are the best teachers.
//  - The AQU-730 read wall holds: examples are other people's recordings and
//    transcripts, so a lane the caller was not granted yields nothing.
//  - The audio URL opens exactly one object, briefly, and nothing else.

import { afterAll, describe, expect, it } from "vitest"
import {
  handleTranscriptionExamplesRequest, jaccard, rankExamples, signedExampleAudioUrl,
  type ExampleCandidate,
} from "../events/transcription-examples-route"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"

const SECRET = "omni-examples-secret"
const P = "proj-omni"
const F = "file-a"
const SRC_LANE = "aa00bb11"
const DEFAULT_LANE = "cc22dd33"
const FR_LANE = "ee44ff55"

interface Take {
  cell: string
  audio?: string
  durationMs: number | null
  trimStartMs?: number
  trimEndMs?: number
  lane?: string | null
  validators?: number
  selected?: number
  deleted?: number
  role?: "dub" | "source"
  slot?: string
  createdTs?: number
}
const take = (t: Take) => ({
  project_id: P, file_id: F, cell_id: t.cell, audio_id: t.audio ?? `${t.cell}.webm`,
  slot: t.slot ?? "recording", url: `frontier-audio://${t.audio ?? `${t.cell}.webm`}`,
  duration_ms: t.durationMs, trim_start_ms: t.trimStartMs ?? null, trim_end_ms: t.trimEndMs ?? null,
  lane_id: t.lane === undefined ? DEFAULT_LANE : t.lane, validator_count: t.validators ?? 0,
  selected: t.selected ?? 1, deleted: t.deleted ?? 0, role: t.role ?? "dub",
  event_id: `ev-${t.cell}-${t.audio ?? ""}`, created_ts: t.createdTs ?? 1,
})
const cell = (id: string, side: "source" | "target", value: string, lane: string, validated = 0) => ({
  project_id: P, file_id: F, cell_id: id, side, value, lane_id: lane, validated,
  event_id: `ev-cell-${id}-${side}-${lane}`, last_edit_at: 1,
})

/** One source + one target row per cell id, text given as [source, target]. */
function cells(texts: Record<string, [string, string]>, lane = DEFAULT_LANE, validated: string[] = []) {
  return Object.entries(texts).flatMap(([id, [src, tgt]]) => [
    cell(id, "source", src, SRC_LANE), cell(id, "target", tgt, lane, validated.includes(id) ? 1 : 0),
  ])
}

const LANES = [
  { id: SRC_LANE, project_id: P, role: "source", name: "Greek", lang_code: "el", legacy_tag: null },
  { id: DEFAULT_LANE, project_id: P, role: "target", name: "Tok Pisin", lang_code: "tpi", legacy_tag: "" },
  { id: FR_LANE, project_id: P, role: "target", name: "French", lang_code: "fr", legacy_tag: "fr" },
]

let h: TestDb | undefined
async function db(seed: { cells: object[]; cell_audio: object[] }) {
  await h?.close()
  h = await makeTestDb({ lanes: LANES, ...seed })
  return h.db
}
afterAll(async () => { await h?.close() })

interface Example { cellId: string; fileId: string; text: string; durationMs: number; audioUrl: string }
async function get(
  pg: AquillaDb, query: string,
  claims: Parameters<typeof makeTestToken>[1] = {}, extraEnv: Record<string, unknown> = {},
) {
  const token = await makeTestToken(SECRET, { projectId: P, fileId: F, role: 400, ...claims })
  const res = await handleTranscriptionExamplesRequest(
    new Request(`https://sync.test/api/v1/projects/${P}/transcription-examples${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    { AQUILLA_PG: pg, SYNC_SECRET_KEY: SECRET, ...extraEnv },
  )
  return res!
}
const ids = async (res: Response) => ((await res.json()) as Example[]).map(e => e.cellId)

describe("transcription examples — what qualifies", () => {
  it("returns only 2–30 s of kept, selected, human, this-lane audio with target text", async () => {
    const pg = await db({
      cells: [
        ...cells({
          ok: ["a", "ami ya"], short: ["a", "x"], long: ["a", "x"], trimmed: ["a", "trimmed"],
          edgeMin: ["a", "two"], edgeMax: ["a", "thirty"], deleted: ["a", "x"], unselected: ["a", "x"],
          programme: ["a", "x"], tts: ["a", "x"], empty: ["a", "   "], legacyNull: ["a", "legacy"],
        }),
        ...cells({ french: ["a", "bonjour"] }, FR_LANE),
      ],
      cell_audio: [
        take({ cell: "ok", durationMs: 9000 }),
        take({ cell: "short", durationMs: 1500 }),
        take({ cell: "long", durationMs: 31000 }),
        // 40 s recorded, 10 s kept: the kept window is what counts.
        take({ cell: "trimmed", durationMs: 40000, trimStartMs: 5000, trimEndMs: 15000 }),
        take({ cell: "edgeMin", durationMs: 2000 }),
        take({ cell: "edgeMax", durationMs: 30000 }),
        take({ cell: "deleted", durationMs: 9000, deleted: 1 }),
        take({ cell: "unselected", durationMs: 9000, selected: 0 }),
        take({ cell: "programme", durationMs: 9000, role: "source", lane: SRC_LANE }),
        take({ cell: "tts", durationMs: 9000, slot: "generatedVoice" }),
        take({ cell: "empty", durationMs: 9000 }),
        // A dub that predates lane ids belongs to the '' lane.
        take({ cell: "legacyNull", durationMs: 9000, lane: null }),
        take({ cell: "french", durationMs: 9000, lane: FR_LANE }),
      ],
    })
    const res = await get(pg, "?lane=")
    expect(res.status).toBe(200)
    const body = (await res.json()) as Example[]
    expect(body.map(e => e.cellId).sort()).toEqual(["edgeMax", "edgeMin", "legacyNull", "ok", "trimmed"])
    expect(body.find(e => e.cellId === "trimmed")).toMatchObject({ durationMs: 10000, text: "trimmed", fileId: F })
    expect(await ids(await get(pg, "?lane=fr"))).toEqual(["french"])
  })

  it("leaves out the cell being transcribed and caps the count at 10", async () => {
    const texts = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`c${i}`, ["a", `t${i}`] as [string, string]]))
    const pg = await db({
      cells: cells(texts),
      cell_audio: Object.keys(texts).map((id, i) => take({ cell: id, durationMs: 9000, createdTs: i })),
    })
    const all = await ids(await get(pg, "?lane=&excludeCellId=c11&limit=50"))
    expect(all).toHaveLength(10)
    expect(all).not.toContain("c11")
    expect(await ids(await get(pg, "?lane=&limit=3"))).toHaveLength(3)
  })
})

describe("transcription examples — ranking", () => {
  it("puts validated first, then the most similar source text", async () => {
    const pg = await db({
      cells: cells({
        similar: ["in the beginning god created", "t1"],
        unrelated: ["the lord is my shepherd", "t2"],
        validatedCell: ["love one another", "t3"],
        validatedTake: ["blessed are the meek", "t4"],
      }, DEFAULT_LANE, ["validatedCell"]),
      cell_audio: [
        take({ cell: "similar", durationMs: 9000, createdTs: 1 }),
        take({ cell: "unrelated", durationMs: 9000, createdTs: 9 }),
        take({ cell: "validatedCell", durationMs: 9000, createdTs: 2 }),
        take({ cell: "validatedTake", durationMs: 9000, createdTs: 3, validators: 1 }),
      ],
    })
    const order = await ids(await get(pg, `?lane=&sourceText=${encodeURIComponent("In the beginning God created the heavens")}`))
    expect(order.slice(0, 2).sort()).toEqual(["validatedCell", "validatedTake"])
    expect(order.slice(2)).toEqual(["similar", "unrelated"])
  })

  it("without source text prefers 8–15 s clips, then newest", () => {
    const c = (cellId: string, durationMs: number, createdTs: number): ExampleCandidate => ({
      cellId, fileId: F, audioId: cellId, text: "t", sourceText: "", durationMs, validated: false, createdTs,
    })
    const ranked = rankExamples([c("short", 3000, 9), c("mid", 10000, 1), c("mid-new", 12000, 5), c("long", 28000, 8)], undefined, 10)
    expect(ranked.map(r => r.cellId)).toEqual(["mid-new", "mid", "short", "long"])
  })

  it("scores similarity as Jaccard over lower-cased words of any script", () => {
    expect(jaccard("In the Beginning", "the beginning was")).toBeCloseTo(2 / 4)
    expect(jaccard("Ἐν ἀρχῇ ἦν", "ἐν ἀρχῇ")).toBeCloseTo(2 / 3)
    expect(jaccard("", "x")).toBe(0)
  })
})

describe("transcription examples — auth and read wall", () => {
  const seed = () => db({
    cells: [...cells({ mine: ["a", "ami"] }), ...cells({ theirs: ["a", "bonjour"] }, FR_LANE)],
    cell_audio: [take({ cell: "mine", durationMs: 9000 }), take({ cell: "theirs", durationMs: 9000, lane: FR_LANE })],
  })

  it("requires a token and contributor role", async () => {
    const pg = await seed()
    const anon = await handleTranscriptionExamplesRequest(
      new Request(`https://sync.test/api/v1/projects/${P}/transcription-examples?lane=`),
      { AQUILLA_PG: pg, SYNC_SECRET_KEY: SECRET },
    )
    expect(anon!.status).toBe(401)
    expect((await get(pg, "?lane=", { role: 300 })).status).toBe(403)
    expect((await get(pg, "?lane=", { projectId: "other" })).status).toBe(403)
  })

  it("returns nothing for a lane the caller was not granted while the wall is on", async () => {
    const pg = await seed()
    const grants = { laneGrants: [{ lane: DEFAULT_LANE, level: 400 }] }
    const wall = { LANE_READ_WALL: "1" }
    expect(await ids(await get(pg, "?lane=fr", grants, wall))).toEqual([])
    expect(await ids(await get(pg, "?lane=", grants, wall))).toEqual(["mine"])
  })
})

describe("example audio URL", () => {
  function bucket(objects: Record<string, string>) {
    return {
      get: async (key: string) => key in objects
        ? { body: new Blob([objects[key]]).stream(), size: objects[key].length, httpMetadata: { contentType: "audio/webm" } }
        : null,
    } as unknown as R2Bucket
  }
  const serve = (url: string, objects: Record<string, string>) =>
    handleTranscriptionExamplesRequest(new Request(url), { SYNC_SECRET_KEY: SECRET, SNAPSHOTS: bucket(objects) })
  const key = `projects/${P}/files/${F}/audio/a.webm`
  const now = () => Math.floor(Date.now() / 1000)

  it("is minted on the public base and opens exactly the signed object", async () => {
    const pg = await db({ cells: cells({ c: ["a", "ami"] }), cell_audio: [take({ cell: "c", audio: "a.webm", durationMs: 9000 })] })
    const [example] = (await (await get(pg, "?lane=", {}, { DIARIZATION_PUBLIC_BASE: "https://api.test/sync/" })).json()) as Example[]
    expect(example.audioUrl.startsWith("https://api.test/sync/api/v1/transcription-examples/audio?")).toBe(true)
    // Served path has no /sync prefix inside the worker (stripped upstream).
    const local = example.audioUrl.replace("https://api.test/sync", "https://w")
    const res = (await serve(local, { [key]: "webm-bytes" }))!
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("webm-bytes")
  })

  it("refuses a tampered object, a bad signature, and an expired link alike", async () => {
    const objects = { [key]: "webm-bytes", [`projects/${P}/files/${F}/audio/b.webm`]: "other" }
    const good = await signedExampleAudioUrl("https://w", SECRET, P, F, "a.webm", now() + 600)
    const swapped = good.replace("a=a.webm", "a=b.webm")
    const badSig = good.replace(/sig=[0-9a-f]{4}/, "sig=0000")
    const expired = await signedExampleAudioUrl("https://w", SECRET, P, F, "a.webm", now() - 1)
    const otherSecret = await signedExampleAudioUrl("https://w", "not-the-key", P, F, "a.webm", now() + 600)
    expect((await serve(good, objects))!.status).toBe(200)
    for (const url of [swapped, badSig, expired, otherSecret]) {
      expect((await serve(url, objects))!.status, url).toBe(404)
    }
  })
})
