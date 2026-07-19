import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import app from '../index'
import { authHeader, jwtFor, seedUser } from './helpers/db'

async function seed(): Promise<void> {
  await seedUser(1, 'owner')
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Org', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    'INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)',
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('p1', 'Progress', 1, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO files (id, project_id, name, event_id, approved_count) VALUES ('f1', 'p1', 'GEN', 'file-event', 2)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO cells (
       project_id, file_id, cell_id, side, value, event_id, last_edit_at,
       validated, endorsement_count, word_count
     ) VALUES
       ('p1', 'f1', 'c1', 'target', 'one', 'edit-1', 1, 1, 1, 1),
       ('p1', 'f1', 'c2', 'target', 'two', 'edit-2', 1, 1, 2, 1)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO cell_validators (project_id, file_id, cell_id, event_id, username, decided_ts) VALUES
       ('p1', 'f1', 'c1', 'edit-1', 'alice', 1),
       ('p1', 'f1', 'c2', 'edit-2', 'alice', 1),
       ('p1', 'f1', 'c2', 'edit-2', 'bob', 2)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_settings (project_id, settings, version, updated_by)
     VALUES ('p1', '{"validationCount":1}', 1, 1)`,
  ).run()
}

async function patchSettings(ifMatchVersion: number, validationCount: number): Promise<Response> {
  return app.request('/api/v2/projects/p1/settings', {
    method: 'PATCH',
    headers: authHeader(await jwtFor('owner')),
    body: JSON.stringify({ settings: { validationCount }, ifMatchVersion }),
  }, env)
}

describe('project validationCount reprojection', () => {
  it('atomically updates existing cell and file validation state', async () => {
    await seed()
    const response = await patchSettings(1, 2)
    expect(response.status).toBe(200)

    const cells = await env.AQUILLA_PG.prepare(
      "SELECT cell_id, validated FROM cells WHERE project_id = 'p1' ORDER BY cell_id",
    ).all<{ cell_id: string; validated: number }>()
    expect(cells.results.map((row) => [row.cell_id, Number(row.validated)])).toEqual([
      ['c1', 0],
      ['c2', 1],
    ])
    const file = await env.AQUILLA_PG.prepare(
      "SELECT approved_count FROM files WHERE id = 'f1'",
    ).first<{ approved_count: number }>()
    expect(Number(file?.approved_count)).toBe(1)
  })

  it('a version conflict performs no projection changes', async () => {
    await seed()
    expect((await patchSettings(1, 2)).status).toBe(200)
    const conflict = await patchSettings(1, 1)
    expect(conflict.status).toBe(409)

    const cells = await env.AQUILLA_PG.prepare(
      "SELECT cell_id, validated FROM cells WHERE project_id = 'p1' ORDER BY cell_id",
    ).all<{ cell_id: string; validated: number }>()
    expect(cells.results.map((row) => Number(row.validated))).toEqual([0, 1])
    const file = await env.AQUILLA_PG.prepare(
      "SELECT approved_count FROM files WHERE id = 'f1'",
    ).first<{ approved_count: number }>()
    expect(Number(file?.approved_count)).toBe(1)
  })

  it('normalizes an out-of-range validation threshold to the 15+ cap', async () => {
    await seed()
    const response = await patchSettings(1, 99)
    expect(response.status).toBe(200)
    const body = await response.json() as { settings: { validationCount?: number } }
    expect(body.settings.validationCount).toBe(15)
  })
})
