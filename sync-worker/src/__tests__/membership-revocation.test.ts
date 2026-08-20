// AQU-346: removing a member must terminate their WRITE access on their very
// next flush — not at token expiry.
//
// WHY these tests exist: sync-token verification is pure JWT, so a token
// proves membership at MINT time only. Before AQU-346, deleting a user's
// project_members row left their outstanding (≤15 min) token fully
// write-capable — observed in the wild as "he kicked me from the project and
// I'm still on it". The membership re-check in events/route.ts is the fix;
// these tests pin the enforcement contract:
//
//   - removed member + still-valid token  → POST /events 403 "membership revoked"
//   - any surviving AD-12 grant path (org / group / creator) → still accepted
//     (removing the direct row is NOT a demotion of additive paths)
//   - src:"platform" tokens (ADMIN_EMAILS operators) are exempt — the
//     documented platform-admin exemption (no membership rows to re-check)
//   - missing project row → accepted (mint-time gate is the authority; the
//     sync-token route auto-registers projects, so real removals always have
//     a row)

import { describe, it, expect, vi } from 'vitest'

vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleEventsWriteRequest } from '../events/route'
import { checkProjectMembership } from '../events/membership'
import { makeTestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import type { RawEvent } from '../events/types'

const SECRET = 'test-secret'
const PROJECT = 'proj-revoke'
const FILE = 'file-x'

async function tokenFor(
  userId: number,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  return makeTestToken(SECRET, {
    userId,
    username: `user-${userId}`,
    projectId: PROJECT,
    fileId: FILE,
    role: 400,
    ...overrides,
  } as never)
}

function commitEvent(id: string, userId: number): RawEvent<'target.cell.create'> {
  return {
    id,
    schemaVersion: 1,
    kind: 'target.cell.create',
    projectId: PROJECT,
    fileId: FILE,
    cellId: `cell-${id}`,
    parentId: null,
    author: `user-${userId}`,
    payload: { cellId: `cell-${id}`, value: 'hello', valueHtml: '<p>hello</p>' },
    clientTs: 1000,
  }
}

function makeEnv(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }
}

async function post(
  db: AquillaDb,
  events: unknown[],
  token: string,
): Promise<{ accepted: Array<{ id: string }>; rejected: Array<{ id: string; status: number; reason: string }> }> {
  const req = new Request('https://worker/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ events }),
  })
  const res = (await handleEventsWriteRequest(req, makeEnv(db)))!
  return (await res.json()) as never
}

const projectRow = (overrides: Record<string, unknown> = {}) => ({
  id: PROJECT,
  name: 'Revocation test',
  created_by: 999, // someone else — creator path must not mask the removal
  ...overrides,
})

describe('AQU-346 — membership re-check on POST /events', () => {
  it('refuses a removed member on the very next flush, while the token is still valid', async () => {
    const { db, pg } = await makeTestDb({
      projects: [projectRow()],
      project_members: [{ project_id: PROJECT, user_id: 1, role_level: 400 }],
    })
    const token = await tokenFor(1)

    // Member in good standing: write accepted.
    const before = await post(db, [commitEvent('evt-before', 1)], token)
    expect(before.accepted.map((a) => a.id)).toContain('evt-before')
    expect(before.rejected).toHaveLength(0)

    // The owner removes them (what DELETE /members/:userId does server-side).
    await pg.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [PROJECT, 1])

    // Same still-valid token, next flush: refused. This is the regression
    // the LAN-party session hit — the token outliving the membership.
    const after = await post(db, [commitEvent('evt-after', 1)], token)
    expect(after.accepted).toHaveLength(0)
    expect(after.rejected).toEqual([
      { id: 'evt-after', status: 403, reason: 'membership revoked' },
    ])
  })

  it('rejects every event in a batch from a revoked author, not just the first', async () => {
    const { db } = await makeTestDb({
      projects: [projectRow()],
      // no grant rows at all — user 1 was fully removed
    })
    const token = await tokenFor(1)
    const result = await post(db, [commitEvent('evt-1', 1), commitEvent('evt-2', 1)], token)
    expect(result.accepted).toHaveLength(0)
    expect(result.rejected.map((r) => r.reason)).toEqual(['membership revoked', 'membership revoked'])
  })

  it('keeps accepting when a Maintainer+ org grant survives — removing the direct row is not a demotion (AD-12)', async () => {
    const { db } = await makeTestDb({
      projects: [projectRow({ org_id: 5 })],
      org_members: [{ org_id: 5, user_id: 1, role_level: 600 }],
    })
    const result = await post(db, [commitEvent('evt-org', 1)], await tokenFor(1))
    expect(result.accepted.map((a) => a.id)).toContain('evt-org')
    expect(result.rejected).toHaveLength(0)
  })

  it('AQU-435: a sub-Maintainer org grant does NOT survive — the org path only contributes at Maintainer(600)+', async () => {
    const { db } = await makeTestDb({
      projects: [projectRow({ org_id: 5 })],
      org_members: [{ org_id: 5, user_id: 1, role_level: 400 }],
    })
    const result = await post(db, [commitEvent('evt-org-below-floor', 1)], await tokenFor(1))
    expect(result.accepted).toHaveLength(0)
    expect(result.rejected).toEqual([
      { id: 'evt-org-below-floor', status: 403, reason: 'membership revoked' },
    ])
  })

  it('keeps accepting when a group grant survives', async () => {
    const { db } = await makeTestDb({
      projects: [projectRow()],
      group_members: [{ group_id: 7, user_id: 1 }],
      group_project_grants: [{ group_id: 7, project_id: PROJECT, role_level: 400 }],
    })
    const result = await post(db, [commitEvent('evt-group', 1)], await tokenFor(1))
    expect(result.accepted.map((a) => a.id)).toContain('evt-group')
    expect(result.rejected).toHaveLength(0)
  })

  it('keeps accepting the project creator (creator path has no row to delete)', async () => {
    const { db } = await makeTestDb({
      projects: [projectRow({ created_by: 1 })],
    })
    const result = await post(db, [commitEvent('evt-creator', 1)], await tokenFor(1))
    expect(result.accepted.map((a) => a.id)).toContain('evt-creator')
    expect(result.rejected).toHaveLength(0)
  })

  it('exempts src:"platform" tokens — the documented platform-admin exemption', async () => {
    const { db } = await makeTestDb({
      projects: [projectRow()],
      // no grant rows: a platform operator has none by design
    })
    const token = await tokenFor(1, { role: 700, src: 'platform' })
    const result = await post(db, [commitEvent('evt-platform', 1)], token)
    expect(result.accepted.map((a) => a.id)).toContain('evt-platform')
    expect(result.rejected).toHaveLength(0)
  })

  it('fails open when the project row is missing — mint-time gating is the authority', async () => {
    const { db } = await makeTestDb({})
    const result = await post(db, [commitEvent('evt-noproj', 1)], await tokenFor(1))
    expect(result.accepted.map((a) => a.id)).toContain('evt-noproj')
    expect(result.rejected).toHaveLength(0)
  })
})

describe('checkProjectMembership (unit)', () => {
  it('returns "revoked" only when the project exists and no grant path remains', async () => {
    const { db, pg } = await makeTestDb({
      projects: [projectRow()],
      project_members: [{ project_id: PROJECT, user_id: 1, role_level: 100 }],
    })
    expect(await checkProjectMembership(db, PROJECT, 1)).toBe('ok')
    await pg.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [PROJECT, 1])
    expect(await checkProjectMembership(db, PROJECT, 1)).toBe('revoked')
    // Unknown project → fail open (mint-time authority).
    expect(await checkProjectMembership(db, 'no-such-project', 1)).toBe('ok')
  })
})
