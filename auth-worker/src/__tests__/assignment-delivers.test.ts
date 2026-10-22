// Media redesign slice 1: an assignment's done lines follow what its language
// DELIVERS (src/lib/lanes/lane-delivers.ts), the same rule the dashboard, the
// plan board and Monday count by. P1.4 ("Ana's assignment progress, 2 of 23
// done") and P1.6.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { getMyAssignments, getOrgAssignmentWorkload } from "../services/assignments"
import { laneLineDone, type LaneDelivers } from "../../../src/lib/lanes/lane-delivers"
import type { Env } from "../types"
import { seedUser } from "./helpers/db"

const testEnv = env as unknown as Env

/** One line of the fixture: its text votes (null = no text) and its take's votes (null = no take). */
interface Line {
  text: number | null
  audio: number | null
}

/**
 * Org 1, project 'pa', file 'f1', one target lane 'ln-sw' (tag 'sw') set to
 * `delivers`, both required-validator counts at `threshold`. Ana holds one
 * whole-file assignment over every line.
 */
async function seed(delivers: LaneDelivers | null, lines: Line[], threshold = 2) {
  await seedUser(1, "lee")
  await seedUser(2, "ana")
  await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Org', 1)").run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 400, 1)",
  ).run()
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'Ruth', 1, 1)").run()
  await env.AQUILLA_PG.prepare("INSERT INTO project_settings (project_id, settings) VALUES ('pa', ?)")
    .bind(JSON.stringify({ validationCount: threshold, validationCountAudio: threshold }))
    .run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('pa', 1, 700, 1), ('pa', 2, 400, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO events (id, schema_version, project_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES ('e1', 1, 'pa', 'file.create', 'lee', '{}', 1, 1, 1)",
  ).run()
  await env.AQUILLA_PG.prepare("INSERT INTO files (id, project_id, name, event_id) VALUES ('f1', 'pa', 'Ruth 2', 'e1')").run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO lanes (id, project_id, role, name, legacy_tag, position, delivers, records_audio) VALUES
      ('ln-src', 'pa', 'source', 'English', NULL, 0, NULL, false),
      ('ln-sw', 'pa', 'target', 'Swahili', 'sw', 1, ?, ?)`,
  ).bind(delivers, delivers !== "text").run()
  for (const [i, line] of lines.entries()) {
    const cell = `c${i + 1}`
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, lane_id, value, event_id, last_edit_at, canonical_ref)
       VALUES ('pa', 'f1', ?, 'source', 'ln-src', 'verse', 'e1', 1, ?)`,
    ).bind(cell, `RUT 2:${i + 1}`).run()
    if (line.text != null) {
      await env.AQUILLA_PG.prepare(
        `INSERT INTO cells (project_id, file_id, cell_id, side, lane_id, value, event_id, last_edit_at, endorsement_count, validated)
         VALUES ('pa', 'f1', ?, 'target', 'ln-sw', 'neno', 'e1', 1, ?, ?)`,
      ).bind(cell, line.text, line.text >= threshold ? 1 : 0).run()
    }
    if (line.audio != null) {
      await env.AQUILLA_PG.prepare(
        `INSERT INTO cell_audio (project_id, file_id, cell_id, audio_id, slot, url, duration_ms, selected, deleted,
                                 event_id, created_ts, role, validator_count, lane_id)
         VALUES ('pa', 'f1', ?, ?, 'recording', 'frontier-audio://x.wav', 1000, 1, 0, 'ae', 1, 'dub', ?, 'ln-sw')`,
      ).bind(cell, `a${i + 1}`, line.audio).run()
    }
  }
  await env.AQUILLA_PG.prepare(
    `INSERT INTO assignments (assignment_id, project_id, assignee_user_id, scope_kind, scope_label, lane_id, cells_total, created_by, created_at)
     VALUES ('as-ana', 'pa', 2, 'books', 'Ruth 2', 'ln-sw', ?, 1, 1000)`,
  ).bind(lines.length).run()
  for (let i = 0; i < lines.length; i++) {
    await env.AQUILLA_PG.prepare("INSERT INTO assignment_cells (assignment_id, file_id, cell_id) VALUES ('as-ana', 'f1', ?)")
      .bind(`c${i + 1}`)
      .run()
  }
}

async function anaProgress() {
  const mine = await getMyAssignments(testEnv, "pa", 2)
  const row = mine.find((r) => r.assignmentId === "as-ana")!
  return { total: row.cellsTotal, done: row.cellsDone }
}

describe("assignment progress by what the language delivers", () => {
  it("an Audio language counts lines whose recording two people approved: 2 of 23 (P1.4)", async () => {
    // Ruth 2: 5 recorded, 2 approved by two people; nobody wrote any text.
    const lines: Line[] = Array.from({ length: 23 }, (_, i) => ({
      text: null,
      audio: i < 2 ? 2 : i < 5 ? 1 : null,
    }))
    await seed("audio", lines)
    expect(await anaProgress()).toEqual({ total: 23, done: 2 })
    const workload = await getOrgAssignmentWorkload(testEnv, 1)
    expect(workload.find((r) => r.assignmentId === "as-ana")).toMatchObject({ cellsTotal: 23, cellsDone: 2 })
  })

  it("an Audio language ignores text, however validated", async () => {
    await seed("audio", [{ text: 3, audio: null }, { text: 3, audio: 0 }, { text: null, audio: 2 }])
    expect(await anaProgress()).toEqual({ total: 3, done: 1 })
  })

  it("Text and audio counts a line only when both halves are done (P1.6)", async () => {
    const lines: Line[] = [
      ...Array.from({ length: 4 }, () => ({ text: 1, audio: 1 })),
      ...Array.from({ length: 3 }, () => ({ text: 1, audio: null })),
      ...Array.from({ length: 2 }, () => ({ text: 0, audio: 1 })),
      { text: null, audio: null },
    ]
    await seed("text_and_audio", lines, 1)
    expect(await anaProgress()).toEqual({ total: 10, done: 4 })
  })

  it("Text, and a language nobody has chosen for, count validated text exactly as before", async () => {
    const lines: Line[] = [
      { text: 2, audio: 2 }, { text: 2, audio: null }, { text: 1, audio: 2 }, { text: null, audio: 2 },
    ]
    await seed("text", lines)
    expect(await anaProgress()).toEqual({ total: 4, done: 2 })
  })

  it("an unchosen language reads like Text", async () => {
    await seed(null, [{ text: 2, audio: null }, { text: null, audio: 2 }])
    expect(await anaProgress()).toEqual({ total: 2, done: 1 })
  })

  it("agrees with the shared line rule on every combination", async () => {
    const lines: Line[] = []
    for (const text of [null, 0, 2]) for (const audio of [null, 0, 2]) lines.push({ text, audio })
    for (const delivers of ["text", "audio", "text_and_audio"] as const) {
      await seed(delivers, lines)
      const expected = lines.filter((l) =>
        laneLineDone(delivers, { textValidated: (l.text ?? 0) >= 2, audioApproved: (l.audio ?? -1) >= 2 }),
      ).length
      expect((await anaProgress()).done, delivers).toBe(expected)
      await env.AQUILLA_PG.prepare(
        "TRUNCATE users, organizations, org_members, projects, project_settings, project_members, events, files, lanes, cells, cell_audio, assignments, assignment_cells RESTART IDENTITY CASCADE",
      ).run()
    }
  })
})
