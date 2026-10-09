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
//   - missing project row → accepted (mint-time gate is the authority; AQU-299
//     / SEC-9: the sync-token route 403s an unknown projectId, so a live
//     project always has a row and real removals always have one)

import { describe, it, expect, vi } from 'vitest'

vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleEventsWriteRequest } from '../events/route'
import { checkProjectMembership, checkProjectMembershipDetailed } from '../events/membership'
import {
  resolveProjectRoleIncludingArchivedShared,
  setAccessGrantsMode,
  type AccessGrantsMode,
} from '../../../db/shared/project-roles'
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

function commentEvent(id: string, userId: number): RawEvent<'comment.create'> {
  return {
    id,
    schemaVersion: 1,
    kind: 'comment.create',
    projectId: PROJECT,
    fileId: FILE,
    cellId: `cell-${id}`,
    parentId: null,
    author: `user-${userId}`,
    payload: {
      commentId: `cmt-${id}`,
      scope: { kind: 'cell', fileId: FILE, cellId: `cell-${id}` },
      body: 'looks good',
      parentCommentId: null,
    },
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

describe('AQU-1787 — the write perimeter resolves through the shared role resolver', () => {
  // The Biblica ETT shape: org role Project Lead (500), the project reached
  // ONLY through a team attached at Contributor (400), no direct
  // project_members row. AQU-1274 taught the mint-side resolver that the org
  // role contributes here, so the token claims 500; the write perimeter's own
  // SQL still resolved 400 and the downgrade gate 403'd every write.
  const teamOnlyOrgLeadFixture = () => ({
    projects: [projectRow({ org_id: 5 })],
    org_members: [{ org_id: 5, user_id: 1, role_level: 500 }],
    group_members: [{ group_id: 7, user_id: 1 }],
    group_project_grants: [{ group_id: 7, project_id: PROJECT, role_level: 400 }],
  })

  it('accepts a target-cell write from an org Project Lead reaching the project only through a Contributor team', async () => {
    const { db } = await makeTestDb(teamOnlyOrgLeadFixture())
    const result = await post(db, [commitEvent('evt-1787-cell', 1)], await tokenFor(1, { role: 500 }))
    expect(result.rejected).toHaveLength(0)
    expect(result.accepted.map((a) => a.id)).toContain('evt-1787-cell')
  })

  it('accepts a comment from the same member — every write kind was rejected, not just cell edits', async () => {
    const { db } = await makeTestDb(teamOnlyOrgLeadFixture())
    const result = await post(db, [commentEvent('evt-1787-cmt', 1)], await tokenFor(1, { role: 500 }))
    expect(result.rejected).toHaveLength(0)
    expect(result.accepted.map((a) => a.id)).toContain('evt-1787-cmt')
  })

  it('still rejects a genuine downgrade of a DIRECT project role (the AQU-1331 gate is intact)', async () => {
    const { db } = await makeTestDb({
      projects: [projectRow()],
      project_members: [{ project_id: PROJECT, user_id: 1, role_level: 100 }],
    })
    const result = await post(db, [commitEvent('evt-1787-down', 1)], await tokenFor(1, { role: 700 }))
    expect(result.accepted).toHaveLength(0)
    expect(result.rejected).toEqual([
      { id: 'evt-1787-down', status: 403, reason: 'role downgraded since token was issued' },
    ])
  })

  it('an explicit lower DIRECT row still restricts someone below their org role (AQU-1274 rule 2)', async () => {
    // Same org/team shape, but with a deliberate per-person grant at Viewer:
    // the org path must NOT lift it, so a token claiming 500 is a downgrade.
    const { db } = await makeTestDb({
      ...teamOnlyOrgLeadFixture(),
      project_members: [{ project_id: PROJECT, user_id: 1, role_level: 100 }],
    })
    const result = await post(db, [commitEvent('evt-1787-direct-floor', 1)], await tokenFor(1, { role: 500 }))
    expect(result.rejected).toEqual([
      { id: 'evt-1787-direct-floor', status: 403, reason: 'role downgraded since token was issued' },
    ])
  })

  // The parity criterion: whatever the mint would claim is what the write
  // perimeter must resolve, for every grant shape and under every resolver
  // mode. This is the test that would have caught AQU-1787 at the time
  // AQU-1274 landed on the auth-worker side only.
  const PARITY_MATRIX: Array<{ name: string; seed: Record<string, unknown[]>; expected: number }> = [
    {
      name: 'direct only',
      seed: {
        projects: [projectRow()],
        project_members: [{ project_id: PROJECT, user_id: 1, role_level: 400 }],
      },
      expected: 400,
    },
    {
      name: 'team only',
      seed: {
        projects: [projectRow()],
        group_members: [{ group_id: 7, user_id: 1 }],
        group_project_grants: [{ group_id: 7, project_id: PROJECT, role_level: 400 }],
      },
      expected: 400,
    },
    {
      name: 'org Maintainer+',
      seed: {
        projects: [projectRow({ org_id: 5 })],
        org_members: [{ org_id: 5, user_id: 1, role_level: 600 }],
      },
      expected: 600,
    },
    {
      name: 'org sub-Maintainer + team (AQU-1787)',
      seed: {
        projects: [projectRow({ org_id: 5 })],
        org_members: [{ org_id: 5, user_id: 1, role_level: 500 }],
        group_members: [{ group_id: 7, user_id: 1 }],
        group_project_grants: [{ group_id: 7, project_id: PROJECT, role_level: 400 }],
      },
      expected: 500,
    },
    {
      name: 'org sub-Maintainer + team + lower direct row',
      seed: {
        projects: [projectRow({ org_id: 5 })],
        org_members: [{ org_id: 5, user_id: 1, role_level: 500 }],
        group_members: [{ group_id: 7, user_id: 1 }],
        group_project_grants: [{ group_id: 7, project_id: PROJECT, role_level: 400 }],
        project_members: [{ project_id: PROJECT, user_id: 1, role_level: 100 }],
      },
      expected: 400,
    },
    {
      name: 'creator',
      seed: { projects: [projectRow({ created_by: 1 })] },
      expected: 700,
    },
  ]

  const MODES: AccessGrantsMode[] = ['off', 'shadow', 'on']

  for (const mode of MODES) {
    for (const shape of PARITY_MATRIX) {
      it(`parity under ACCESS_GRANTS_RESOLVER=${mode}: ${shape.name}`, async () => {
        const { db } = await makeTestDb(shape.seed as never)
        setAccessGrantsMode(db, mode)
        const live = await checkProjectMembershipDetailed(db, PROJECT, 1)
        const minted = await resolveProjectRoleIncludingArchivedShared(db, { id: '1' }, PROJECT)
        expect(live.status).toBe('ok')
        expect(live.roleLevel).toBe(shape.expected)
        // What the write perimeter resolves IS what the mint would claim, so
        // the downgrade gate can never fire on an unchanged membership.
        expect(live.roleLevel).toBe(minted?.level ?? null)
      })
    }
  }
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
