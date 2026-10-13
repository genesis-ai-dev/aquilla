// The react watcher's bookmark table (db/shared/agent-react-state.ts, AQU-1846).
//
// WHY these assertions: the bookmark used to live in the unvalidated
// project-settings JSON blob, so its reader had to treat any shape as "never
// swept" rather than throw — the alternative is a watcher that reacts to a
// project's entire history, or one that takes the cron down. Moving to a typed
// column removes most of that risk but not all of it: `cursor_ms` is nullable
// BIGINT and `last_reaction_at` is free-form jsonb, both writable by hand. So
// the tolerance is pinned here, against real rows, plus the two properties the
// rotation depends on — a visit stamp that is independent of the cursor, and a
// candidate ordering that puts the least-recently-swept project first.

import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { seedUser } from "./helpers/db"
import {
  listReactProjects,
  markAgentReactSwept,
  readAgentReactState,
  writeAgentReactState,
} from "../../../db/shared/agent-react-state"

beforeEach(async () => {
  await seedUser(1, "owner")
})

async function seedProject(id: string, react: boolean): Promise<void> {
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, 1)")
    .bind(id, id)
    .run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_settings (project_id, settings, version) VALUES (?, ?, 1)",
  )
    .bind(id, JSON.stringify({ agentMode: { react } }))
    .run()
}

async function rawState(projectId: string) {
  return env.AQUILLA_PG
    .prepare(
      "SELECT cursor_ms, last_reaction_at, last_swept_at FROM agent_react_state WHERE project_id = ?",
    )
    .bind(projectId)
    .first<{ cursor_ms: number | null; last_reaction_at: unknown; last_swept_at: string | null }>()
}

describe("readAgentReactState", () => {
  it("reads an empty bookmark for a project with no row", async () => {
    expect(await readAgentReactState(env.AQUILLA_PG, "nobody")).toEqual({
      cursor: null,
      lastReactionAt: {},
    })
  })

  it("round-trips a cursor and cooldown stamps", async () => {
    await seedProject("p1", true)
    await writeAgentReactState(env.AQUILLA_PG, {
      projectId: "p1",
      state: { cursor: 1_700_000_000_000, lastReactionAt: { "file-a": "2026-08-28T10:00:00.000Z" } },
    })
    expect(await readAgentReactState(env.AQUILLA_PG, "p1")).toEqual({
      cursor: 1_700_000_000_000,
      lastReactionAt: { "file-a": "2026-08-28T10:00:00.000Z" },
    })
  })

  it("reads a hand-written cursor that is not a usable epoch as never-swept", async () => {
    // Reacting to the whole of a project's history is exactly what the bounded
    // lookback default exists to prevent, so 0 and negatives must not pass as
    // a real bookmark.
    await seedProject("p2", true)
    for (const cursor of [0, -5]) {
      await env.AQUILLA_PG.prepare(
        `INSERT INTO agent_react_state (project_id, cursor_ms) VALUES (?, ?)
         ON CONFLICT (project_id) DO UPDATE SET cursor_ms = EXCLUDED.cursor_ms`,
      )
        .bind("p2", cursor)
        .run()
      expect((await readAgentReactState(env.AQUILLA_PG, "p2")).cursor).toBeNull()
    }
  })

  it("drops non-string cooldown stamps rather than failing the sweep", async () => {
    await seedProject("p3", true)
    await env.AQUILLA_PG.prepare(
      "INSERT INTO agent_react_state (project_id, last_reaction_at) VALUES (?, ?::jsonb)",
    )
      .bind("p3", { good: "2026-01-01T00:00:00Z", bad: 5, empty: "" })
      .run()
    expect((await readAgentReactState(env.AQUILLA_PG, "p3")).lastReactionAt).toEqual({
      good: "2026-01-01T00:00:00Z",
    })
  })
})

describe("writeAgentReactState", () => {
  it("leaves the rotation stamp alone, so writing a cursor is not taking a turn", async () => {
    // The manual "check for updates now" route writes a cursor too. If that
    // counted as a visit, clicking it would push the project behind the others
    // in the cron's queue.
    await seedProject("p4", true)
    await markAgentReactSwept(env.AQUILLA_PG, "p4")
    const stamped = (await rawState("p4"))?.last_swept_at
    expect(stamped).not.toBeNull()

    await writeAgentReactState(env.AQUILLA_PG, {
      projectId: "p4",
      state: { cursor: 1_700_000_000_000, lastReactionAt: {} },
    })
    expect((await rawState("p4"))?.last_swept_at).toEqual(stamped)
  })

  it("stamps a visit without inventing a cursor", async () => {
    await seedProject("p5", true)
    await markAgentReactSwept(env.AQUILLA_PG, "p5")
    const row = await rawState("p5")
    expect(row?.last_swept_at).not.toBeNull()
    expect(row?.cursor_ms).toBeNull()
  })
})

describe("listReactProjects", () => {
  it("orders least-recently-swept first, with never-swept projects ahead of all", async () => {
    await seedProject("a-swept-recently", true)
    await seedProject("b-swept-long-ago", true)
    await seedProject("c-never-swept", true)
    await seedProject("d-react-off", false)
    await env.AQUILLA_PG.prepare(
      "INSERT INTO agent_react_state (project_id, last_swept_at) VALUES (?, now()), (?, now() - interval '1 hour')",
    )
      .bind("a-swept-recently", "b-swept-long-ago")
      .run()

    // `c` sorts first despite the highest id: that is the whole fix.
    expect(await listReactProjects(env.AQUILLA_PG, 10)).toEqual([
      "c-never-swept",
      "b-swept-long-ago",
      "a-swept-recently",
    ])
    // And the limit takes from the FRONT of that rotation.
    expect(await listReactProjects(env.AQUILLA_PG, 2)).toEqual([
      "c-never-swept",
      "b-swept-long-ago",
    ])
  })

  it("skips archived and deactivated projects", async () => {
    await seedProject("live", true)
    await seedProject("archived", true)
    await seedProject("inactive", true)
    await env.AQUILLA_PG.prepare("UPDATE projects SET archived_at = now() WHERE id = 'archived'").run()
    await env.AQUILLA_PG.prepare("UPDATE projects SET is_active = FALSE WHERE id = 'inactive'").run()

    expect(await listReactProjects(env.AQUILLA_PG, 10)).toEqual(["live"])
  })
})
