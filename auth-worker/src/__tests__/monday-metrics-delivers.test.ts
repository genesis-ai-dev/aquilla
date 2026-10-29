// Media redesign slice 1: Monday's Status and Completion % (and the Airtable
// push, which reuses these metrics) count each language by what it delivers
// (src/lib/lanes/lane-delivers.ts). P1.3, P1.4, P1.6 and P1.7.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { computeProjectMetrics } from "../lib/monday/metrics"

/** One project, Ruth 1 (22 verses), with the two required-validator counts given. */
async function seed(opts: {
  delivers: string | null
  recordsAudio?: boolean
  settings?: Record<string, unknown>
  lanes?: Array<{ id: string; tag: string; delivers: string | null }>
}) {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO users (id, username, email, password_hash, preferences) VALUES (1, 'lee', 'lee@example.com', 'scrypt:fake$salt$hash', '{}')",
  ).run()
  await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Org', 1)").run()
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'Audio Bible', 1, 1)").run()
  await env.AQUILLA_PG.prepare("INSERT INTO project_settings (project_id, settings) VALUES ('pa', ?)")
    .bind(JSON.stringify(opts.settings ?? { validationCount: 2, validationCountAudio: 2 }))
    .run()
  const lanes = opts.lanes ?? [{ id: "lane-sw", tag: "", delivers: opts.delivers }]
  for (const [i, lane] of lanes.entries()) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO lanes (id, project_id, role, name, legacy_tag, position, delivers, records_audio)
       VALUES (?, 'pa', 'target', ?, ?, ?, ?, ?)`,
    )
      .bind(lane.id, lane.id, lane.tag, i, lane.delivers, opts.recordsAudio ?? lane.delivers !== "text")
      .run()
  }
  await env.AQUILLA_PG.prepare(
    "INSERT INTO files (id, project_id, name, event_id, cell_count, filled_count, approved_count) VALUES ('f1', 'pa', 'RUT', 'e1', 22, 0, 0)",
  ).run()
}

async function progress(row: {
  lane?: string
  file?: string
  total?: number
  filled?: number
  text?: Record<string, number>
  recorded?: number
  audio?: Record<string, number>
  joint?: Record<string, number>
}) {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO file_section_progress
       (project_id, file_id, scope, section_key, lane_id, total_count, filled_count,
        validator_histogram, audio_count, audio_validator_histogram, text_audio_validator_histogram, updated_at)
     VALUES ('pa', ?, 'file', '', ?, ?, ?, ?, ?, ?, ?, 1)`,
  )
    .bind(
      row.file ?? "f1",
      row.lane ?? "lane-sw",
      row.total ?? 22,
      row.filled ?? 0,
      JSON.stringify(row.text ?? {}),
      row.recorded ?? 0,
      JSON.stringify(row.audio ?? {}),
      JSON.stringify(row.joint ?? {}),
    )
    .run()
}

describe("Monday metrics — an Audio language (P1.3)", () => {
  it("reads Not started before the first recording", async () => {
    await seed({ delivers: "audio" })
    await progress({})
    const { project } = (await computeProjectMetrics(env.AQUILLA_PG, "pa"))!
    expect(project.status_auto).toBe("Not started")
    expect(project.completion_pct).toBe(0)
  })

  it("reads In progress from the first recording, with Completion still 0", async () => {
    await seed({ delivers: "audio" })
    await progress({ recorded: 1, audio: { "0": 1 } })
    const { project } = (await computeProjectMetrics(env.AQUILLA_PG, "pa"))!
    expect(project.status_auto).toBe("In progress")
    expect(project.completion_pct).toBe(0)
    expect(project.has_audio_pct).toBe(4.5)
  })

  it("counts a line only once two people approved it: 21 of 22 reads 95.5", async () => {
    await seed({ delivers: "audio" })
    // All 22 recorded; 21 have both votes, one has a single vote.
    await progress({ recorded: 22, audio: { "2": 21, "1": 1 } })
    const { project } = (await computeProjectMetrics(env.AQUILLA_PG, "pa"))!
    expect(project.status_auto).toBe("In progress")
    expect(project.completion_pct).toBe(95.5)
    expect(project.validated_count).toBe(21)
    expect(project.audio_validated_pct).toBe(95.5)
  })

  it("reads Complete once every line's recording is approved", async () => {
    await seed({ delivers: "audio" })
    await progress({ recorded: 22, audio: { "2": 22 } })
    const { project, files } = (await computeProjectMetrics(env.AQUILLA_PG, "pa"))!
    expect(project.status_auto).toBe("Complete")
    expect(project.completion_pct).toBe(100)
    expect(files[0]!.metrics.status_auto).toBe("Complete")
  })

  it("uses the audio count, not the text one (gap 1)", async () => {
    await seed({ delivers: "audio", settings: { validationCount: 3, validationCountAudio: 1 } })
    await progress({ recorded: 22, audio: { "1": 11 } })
    const { project } = (await computeProjectMetrics(env.AQUILLA_PG, "pa"))!
    expect(project.completion_pct).toBe(50)
  })

  it("measures a dubbing file against its cue sheet, in the same language", async () => {
    await seed({ delivers: "audio" })
    await env.AQUILLA_PG.prepare(
      `INSERT INTO files (id, project_id, name, event_id, cell_count, role, anchor_file_id)
       VALUES ('cue1', 'pa', 'RUT cues', 'e2', 40, 'audio-cues', 'f1')`,
    ).run()
    await progress({ total: 300 })
    await progress({ file: "cue1", total: 40, recorded: 20, audio: { "2": 10, "0": 10 } })
    const { project, files } = (await computeProjectMetrics(env.AQUILLA_PG, "pa"))!
    // The cue sheet is not a row of its own, and the episode is 40 heard lines.
    expect(files.map((f) => f.fileId)).toEqual(["f1"])
    expect(project.total_count).toBe(40)
    expect(project.completion_pct).toBe(25)
    expect(project.has_audio_pct).toBe(50)
    expect(project.status_auto).toBe("In progress")
  })
})

describe("Monday metrics — a Text and audio language (P1.6)", () => {
  it("counts a line done only when both halves are approved", async () => {
    await seed({ delivers: "text_and_audio", settings: { validationCount: 1, validationCountAudio: 1 } })
    // Ten lines: 1–4 both, 5–7 text only, 8–9 recording only (text typed), 10 nothing.
    await progress({
      total: 10,
      filled: 9,
      text: { "1": 7, "0": 2 },
      recorded: 6,
      audio: { "1": 6 },
      joint: { "1:1": 4, "0:1": 2 },
    })
    const { project } = (await computeProjectMetrics(env.AQUILLA_PG, "pa"))!
    expect(project.completion_pct).toBe(40)
    expect(project.validated_count).toBe(4)
    expect(project.status_auto).toBe("In progress")
  })

  it("reads In progress on recordings alone, before any text", async () => {
    await seed({ delivers: "text_and_audio", settings: { validationCount: 1, validationCountAudio: 1 } })
    await progress({ total: 10, recorded: 1, audio: { "0": 1 }, joint: { "0:0": 1 } })
    const { project } = (await computeProjectMetrics(env.AQUILLA_PG, "pa"))!
    expect(project.status_auto).toBe("In progress")
  })
})

describe("Monday metrics — existing languages keep their numbers (P1.7)", () => {
  const RECORDED_TEXT_PROJECT = {
    total: 22,
    filled: 15,
    text: { "2": 9, "1": 3, "0": 3 },
    recorded: 12,
    audio: { "2": 7, "0": 5 },
    joint: { "2:2": 5, "0:0": 7 },
  }

  async function metricsFor(delivers: string | null, recordsAudio?: boolean) {
    await seed({ delivers, recordsAudio })
    await progress(RECORDED_TEXT_PROJECT)
    return (await computeProjectMetrics(env.AQUILLA_PG, "pa"))!.project
  }

  it("a Text language and a language nobody has chosen for read exactly the same", async () => {
    const text = await metricsFor("text", false)
    await env.AQUILLA_PG.prepare("TRUNCATE users, organizations, projects, project_settings, lanes, files, file_section_progress RESTART IDENTITY CASCADE").run()
    const unchosen = await metricsFor(null, true)
    expect(unchosen).toEqual(text)
    // ...and that is the old rule: Completion % is the share of lines with text.
    expect(text.completion_pct).toBe(68.2)
    expect(text.validated_count).toBe(9)
    expect(text.status_auto).toBe("In progress")
    expect(text.has_audio_pct).toBe(54.5)
    expect(text.audio_validated_pct).toBe(31.8)
  })

  it("Text and audio keeps every figure but Completion % and Status (question 2, chosen knowingly)", async () => {
    const both = await metricsFor("text_and_audio")
    expect(both.has_audio_pct).toBe(54.5)
    expect(both.audio_validated_pct).toBe(31.8)
    expect(both.filled_count).toBe(15)
    expect(both.completion_pct).toBe(22.7)
  })
})

describe("Monday metrics — one project, two languages (gap 5)", () => {
  it("sums each language's done lines over each language's lines", async () => {
    await seed({
      delivers: null,
      lanes: [
        { id: "lane-fr", tag: "fr", delivers: "text" },
        { id: "lane-sw", tag: "sw", delivers: "audio" },
      ],
    })
    await progress({ lane: "lane-fr", total: 22, filled: 11, text: { "2": 4 } })
    await progress({ lane: "lane-sw", total: 22, recorded: 22, audio: { "2": 11 } })
    const { project } = (await computeProjectMetrics(env.AQUILLA_PG, "pa"))!
    expect(project.total_count).toBe(44)
    // French heads with its text (11), Swahili with its approved recordings (11).
    expect(project.completion_pct).toBe(50)
    expect(project.validated_count).toBe(4 + 11)
  })
})
