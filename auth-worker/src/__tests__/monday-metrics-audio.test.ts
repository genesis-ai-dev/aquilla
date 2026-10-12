// AQU-1771: the board's "Audio validated %" is audio validation, read the way
// the project dashboard reads it — the audio histogram (validator counts on the
// selected dub take, weakest track deciding) at the project's AUDIO count,
// which defaults to one vote and is capped at fifteen. It used to be read off
// the TEXT histogram, and an unset audio count fell back to the text count.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { computeProjectMetrics } from "../lib/monday/metrics"

async function seed(settings: Record<string, unknown>) {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO users (id, username, email, password_hash, preferences) VALUES (1, 'wendi', 'wendi@example.com', 'scrypt:fake$salt$hash', '{}')",
  ).run()
  await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'Ruth', 1, 1)").run()
  await env.AQUILLA_PG.prepare("INSERT INTO project_settings (project_id, settings) VALUES ('pa', ?)")
    .bind(JSON.stringify(settings))
    .run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, position)
     VALUES ('lane0', 'pa', 'target', 'Spanish', NULL, '', 0)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO files (id, project_id, name, event_id, cell_count, filled_count, approved_count) VALUES ('f1', 'pa', 'RUT', 'e1', 10, 10, 0)",
  ).run()
}

async function seedProgress(row: {
  text: Record<string, number>
  audio: Record<string, number>
  structuralCount?: number
  structuralAudio?: Record<string, number>
}) {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO file_section_progress
       (project_id, file_id, scope, section_key, lane_id, total_count, filled_count,
        validator_histogram, audio_validator_histogram,
        structural_count, structural_audio_validator_histogram, updated_at)
     VALUES ('pa', 'f1', 'file', '', 'lane0', 10, 10, ?, ?, ?, ?, 1)`,
  )
    .bind(
      JSON.stringify(row.text),
      JSON.stringify(row.audio),
      row.structuralCount ?? 0,
      JSON.stringify(row.structuralAudio ?? {}),
    )
    .run()
}

describe("Monday metrics — audio validated % (AQU-1771)", () => {
  it("reads the audio histogram at one vote when the audio count is unset", async () => {
    // Text needs two votes and 8 cells have them; only 3 recordings have a vote.
    await seed({ validationCount: 2 })
    await seedProgress({ text: { "2": 8 }, audio: { "1": 3 } })

    const summary = await computeProjectMetrics(env.AQUILLA_PG, "pa")

    expect(summary!.project.validated_pct).toBe(80)
    expect(summary!.project.audio_validated_pct).toBe(30)
  })

  it("caps the audio count at fifteen, like every other reader", async () => {
    await seed({ validationCountAudio: 99 })
    await seedProgress({ text: {}, audio: { "15": 2, "3": 1 } })

    const summary = await computeProjectMetrics(env.AQUILLA_PG, "pa")

    expect(summary!.project.audio_validated_pct).toBe(20)
  })

  it("takes recorded headings out of audio when headings don't count", async () => {
    await seed({ countStructuralCells: false })
    await seedProgress({
      text: {},
      audio: { "1": 4 },
      structuralCount: 2,
      structuralAudio: { "1": 1 },
    })

    const summary = await computeProjectMetrics(env.AQUILLA_PG, "pa")

    expect(summary!.project.total_count).toBe(8)
    expect(summary!.project.audio_validated_pct).toBe(37.5)
  })
})
