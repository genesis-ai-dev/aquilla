// Media redesign slice 1: the org dashboard and the project overview measure
// each language by what it delivers (src/lib/lanes/lane-delivers.ts). The
// server sends each language's choice and its "both halves done" count; the
// shared portfolio math (src/lib/frontier/portfolio-metrics.ts) does the rest,
// on the server's aggregates and in the browser alike. P1.4, P1.5, P1.6, P1.7.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import {
  portfolioActivityStatus,
  portfolioDeliversText,
  portfolioMeasure,
  translatedPct,
  validatedPct,
} from "../../../src/lib/frontier/portfolio-metrics"
import type { LaneDelivers } from "../../../src/lib/lanes/lane-delivers"

const DAY = 24 * 60 * 60 * 1000

interface Lane {
  role?: "source" | "target"
  lane: string
  delivers?: LaneDelivers | null
  totalCells: number
  filledCells: number
  validatedCells: number
  audioCells?: number
  validatedAudioCells?: number
  audioTotalCells?: number
  bothValidatedCells?: number
  lastEditAt: number | null
}
interface Row {
  id: string
  totalCells: number
  filledCells: number
  validatedCells: number
  audioCells: number
  validatedAudioCells: number
  audioTotalCells?: number
  lastEditAt: number | null
  lanes: Lane[]
}

async function seedOrg() {
  await seedUser(1, "lee")
  await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Org', 1)").run()
  await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)").run()
}

/** An Audio Bible: Ruth 1 (22 verses) and Ruth 2 (23), both required-validator counts at 2. */
async function seedAudioBible(id: string, lanes: Array<{ id: string; tag: string; delivers: string | null; recordsAudio?: boolean }>) {
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES (?, 'Audio Bible', 1, 1)").bind(id).run()
  await env.AQUILLA_PG.prepare("INSERT INTO project_settings (project_id, settings) VALUES (?, ?)")
    .bind(id, JSON.stringify({ validationCount: 2, validationCountAudio: 2 }))
    .run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO events (id, schema_version, project_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES (?, 1, ?, 'file.create', 'lee', '{}', 1, 1, 1)",
  ).bind(`ev-${id}`, id).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO files (id, project_id, name, event_id, cell_count, filled_count, approved_count, last_edit_at)
     VALUES (?, ?, 'Ruth 1', ?, 22, 0, 0, 1), (?, ?, 'Ruth 2', ?, 23, 0, 0, 1)`,
  ).bind(`${id}-r1`, id, `ev-${id}`, `${id}-r2`, id, `ev-${id}`).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO lanes (id, project_id, role, name, legacy_tag, position) VALUES (?, ?, 'source', 'English', NULL, 0)",
  ).bind(`${id}-src`, id).run()
  for (const [i, lane] of lanes.entries()) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO lanes (id, project_id, role, name, legacy_tag, position, delivers, records_audio)
       VALUES (?, ?, 'target', ?, ?, ?, ?, ?)`,
    ).bind(lane.id, id, lane.id, lane.tag, i + 1, lane.delivers, lane.recordsAudio ?? lane.delivers !== "text").run()
  }
}

async function progress(row: {
  project: string
  file: string
  lane: string
  total: number
  filled?: number
  text?: Record<string, number>
  recorded?: number
  audio?: Record<string, number>
  joint?: Record<string, number>
  updatedAt?: number
}) {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO file_section_progress
       (project_id, file_id, scope, section_key, lane_id, total_count, filled_count, validator_histogram,
        audio_count, audio_validator_histogram, text_audio_validator_histogram, revision, updated_at)
     VALUES (?, ?, 'file', '', ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  )
    .bind(
      row.project, row.file, row.lane, row.total, row.filled ?? 0,
      JSON.stringify(row.text ?? {}), row.recorded ?? 0, JSON.stringify(row.audio ?? {}),
      JSON.stringify(row.joint ?? {}), row.updatedAt ?? 1,
    )
    .run()
}

async function portfolio(): Promise<Map<string, Row>> {
  const res = await app.request("/api/v2/orgs/1/portfolio", { headers: authHeader(await jwtFor("lee")) }, env)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { projects: Row[] }
  return new Map(body.projects.map((p) => [p.id, p]))
}

const swahili = (row: Row) => row.lanes.find((lane) => lane.role !== "source" && lane.lane === "sw")!

describe("org portfolio — an Audio language (P1.4)", () => {
  it("sends the choice, and the project reads 45 lines, 17 recorded, 9 done", async () => {
    await seedOrg()
    await seedAudioBible("pa", [{ id: "pa-sw", tag: "sw", delivers: "audio" }])
    // Ruth 1: 12 recorded, 7 approved by two people. Ruth 2: 5 recorded, 2 approved.
    await progress({ project: "pa", file: "pa-r1", lane: "pa-src", total: 22 })
    await progress({ project: "pa", file: "pa-r2", lane: "pa-src", total: 23 })
    await progress({ project: "pa", file: "pa-r1", lane: "pa-sw", total: 22, recorded: 12, audio: { "2": 7, "1": 3, "0": 2 } })
    await progress({ project: "pa", file: "pa-r2", lane: "pa-sw", total: 23, recorded: 5, audio: { "2": 2, "0": 3 } })

    const row = (await portfolio()).get("pa")!
    const lane = swahili(row)
    expect(lane).toMatchObject({ delivers: "audio", audioCells: 17, validatedAudioCells: 9, audioTotalCells: 45 })
    expect(portfolioMeasure(row)).toEqual({ total: 45, started: 17, done: 9, headline: 9 })
    expect(validatedPct(row)).toBeCloseTo(9 / 45)
    // No text tile at 0% for it, and no 0% translated (P1.4 expect 3).
    expect(portfolioDeliversText(row)).toBe(false)
  })
})

describe("org portfolio — recording and approving are activity (P1.5)", () => {
  it("reads an Audio project by its recordings: started, not Stalled, while recording goes on", async () => {
    await seedOrg()
    const now = 100 * DAY
    await seedAudioBible("pa", [{ id: "pa-sw", tag: "sw", delivers: "audio" }])
    await seedAudioBible("pb", [{ id: "pb-sw", tag: "sw", delivers: "audio" }])
    // A: approvals yesterday. B: nothing for 20 days.
    await progress({ project: "pa", file: "pa-r1", lane: "pa-sw", total: 22, recorded: 2, audio: { "1": 2 }, updatedAt: now - DAY })
    await progress({ project: "pb", file: "pb-r1", lane: "pb-sw", total: 22, recorded: 2, audio: { "0": 2 }, updatedAt: now - 20 * DAY })
    await env.AQUILLA_PG.prepare("UPDATE files SET last_edit_at = ?").bind(now - 20 * DAY).run()

    const rows = await portfolio()
    expect(portfolioActivityStatus(rows.get("pa")!, now)).toBe("active")
    expect(portfolioActivityStatus(rows.get("pb")!, now)).toBe("stalled")
  })

  it("takes a dubbing language's clock from its cue sheet; a Text language's clock is untouched", async () => {
    await seedOrg()
    const now = 100 * DAY
    await seedAudioBible("pa", [
      { id: "pa-es", tag: "es", delivers: "audio" },
      { id: "pa-fr", tag: "fr", delivers: "text" },
    ])
    await env.AQUILLA_PG.prepare(
      `INSERT INTO files (id, project_id, name, event_id, cell_count, role, anchor_file_id, last_edit_at)
       VALUES ('pa-cue', 'pa', 'Ruth 1 cues', 'ev-pa', 40, 'audio-cues', 'pa-r1', 1)`,
    ).run()
    await progress({ project: "pa", file: "pa-r1", lane: "pa-es", total: 22, updatedAt: now - 20 * DAY })
    await progress({ project: "pa", file: "pa-r1", lane: "pa-fr", total: 22, filled: 3, updatedAt: now - 20 * DAY })
    await progress({ project: "pa", file: "pa-cue", lane: "pa-es", total: 40, recorded: 5, audio: { "0": 5 }, updatedAt: now - DAY })
    await progress({ project: "pa", file: "pa-cue", lane: "pa-fr", total: 40, updatedAt: now - DAY })

    const row = (await portfolio()).get("pa")!
    const byTag = new Map(row.lanes.map((lane) => [lane.lane, lane]))
    expect(byTag.get("es")!.lastEditAt).toBe(now - DAY)
    expect(byTag.get("fr")!.lastEditAt).toBe(now - 20 * DAY)
  })
})

describe("org portfolio — a Text and audio language (P1.6)", () => {
  it("counts 4 of 10 lines done when only four have both halves approved", async () => {
    await seedOrg()
    await seedAudioBible("pa", [{ id: "pa-fr", tag: "fr", delivers: "text_and_audio" }])
    await env.AQUILLA_PG.prepare("UPDATE project_settings SET settings = ? WHERE project_id = 'pa'")
      .bind(JSON.stringify({ validationCount: 1, validationCountAudio: 1 }))
      .run()
    await env.AQUILLA_PG.prepare("UPDATE files SET cell_count = 10 WHERE id = 'pa-r1'").run()
    await env.AQUILLA_PG.prepare("DELETE FROM files WHERE id = 'pa-r2'").run()
    await progress({
      project: "pa", file: "pa-r1", lane: "pa-fr", total: 10, filled: 9, text: { "1": 7, "0": 3 },
      recorded: 6, audio: { "1": 6 }, joint: { "1:1": 4, "0:1": 2 },
    })
    const row = (await portfolio()).get("pa")!
    expect(row.lanes.find((lane) => lane.lane === "fr")).toMatchObject({ delivers: "text_and_audio", bothValidatedCells: 4 })
    expect(portfolioMeasure(row)).toMatchObject({ total: 10, done: 4 })
    expect(validatedPct(row)).toBeCloseTo(0.4)
    expect(portfolioDeliversText(row)).toBe(true)
  })
})

describe("org portfolio — existing languages keep their numbers (P1.7)", () => {
  it("a Text language and an unchosen one read the project-wide figures, exactly as before", async () => {
    await seedOrg()
    await seedAudioBible("pa", [{ id: "pa-de", tag: "", delivers: "text" }])
    await seedAudioBible("pb", [{ id: "pb-de", tag: "", delivers: null, recordsAudio: true }])
    for (const id of ["pa", "pb"]) {
      await env.AQUILLA_PG.prepare("UPDATE files SET filled_count = 15, approved_count = 9 WHERE project_id = ? AND name = 'Ruth 1'").bind(id).run()
      await progress({
        project: id, file: `${id}-r1`, lane: `${id}-de`, total: 22, filled: 15, text: { "2": 9, "0": 13 },
        recorded: 12, audio: { "2": 7, "0": 5 }, joint: { "2:2": 5, "0:0": 7 },
      })
    }
    const rows = await portfolio()
    for (const id of ["pa", "pb"]) {
      const row = rows.get(id)!
      expect(portfolioMeasure(row)).toEqual({
        total: row.totalCells, started: row.filledCells, done: row.validatedCells, headline: row.filledCells,
      })
      expect(validatedPct(row)).toBe(row.validatedCells / row.totalCells)
      expect(translatedPct(row)).toBe(row.filledCells / row.totalCells)
    }
    expect(rows.get("pb")!.lanes.find((lane) => lane.role !== "source")?.delivers).toBeNull()
  })

  it("a French Text language beside a Swahili Audio one: translated reads French alone, done sums both", async () => {
    await seedOrg()
    await seedAudioBible("pa", [
      { id: "pa-fr", tag: "fr", delivers: "text" },
      { id: "pa-sw", tag: "sw", delivers: "audio" },
    ])
    await progress({ project: "pa", file: "pa-r1", lane: "pa-fr", total: 22, filled: 22, text: { "2": 11, "0": 11 } })
    await progress({ project: "pa", file: "pa-r2", lane: "pa-fr", total: 23 })
    await progress({ project: "pa", file: "pa-r1", lane: "pa-sw", total: 22, recorded: 22, audio: { "2": 22 } })
    await progress({ project: "pa", file: "pa-r2", lane: "pa-sw", total: 23 })
    const row = (await portfolio()).get("pa")!
    expect(translatedPct(row)).toBeCloseTo(22 / 45)
    // French: 11 validated of 45. Swahili: 22 approved of 45.
    expect(portfolioMeasure(row)).toMatchObject({ total: 90, done: 33 })
  })
})
