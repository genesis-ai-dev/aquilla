// AQU-1183: the cell-field command family — SetSource, SetTranscription,
// SetTiming, SetTrackOverride.
//
// Covers, per the issue's acceptance criteria:
//   - a staged source correction applies and leaves dependent targets STALE
//     (AD-9: the source chain head moved, the target's pin did not)
//   - SetSource's role gate is HIGHER than SetTranslation's, and the rejection
//     is exercised at exactly the rung between them (contributor 400)
//   - timing stages and applies; start_ms/end_ms land on the cell
//   - fractional milliseconds are REJECTED at the boundary with a clear message
//     (the AQU-927 regression guard)
//   - transcript-only commits leave the imported filename intact
//   - track overrides apply, and the second `allowTrackEditing` gate refuses a
//     restructuring patch at every clearance
//   - the catalog documents all four, and the floors it advertises match the
//     floors the engine actually enforces

import { describe, it, expect, beforeEach, vi } from 'vitest'

// commit.ts → events/route.ts → broadcast.ts → partyserver (cloudflare:*).
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalChangesetsRequest } from '../external/changesets-route'
import { validateCommands, requiredRoleForCommand } from '../external/commands'
import { planCellFields, type CellFieldCommand } from '../external/commands-cell-fields'
import { describeCommand } from '../../../db/shared/command-catalog'
import { ROLE } from '../events/role-policy'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const PROJECT = 'proj-cf'
const FILE = 'file-cf'
const SECRET = 'test-secret'

function makeEnv(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, BASE_URL: 'https://aquilla.app' }
}

let nextUserId = 700
let nextCred = 200

async function memberToken(tdb: TestDb, level: number): Promise<string> {
  const userId = nextUserId++
  const name = `u${userId}`
  await tdb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, 'h')`,
    [userId, name, `${name}@x.com`],
  )
  await tdb.pg.query(
    `INSERT INTO project_members (project_id, user_id, role_level) VALUES ($1, $2, $3)`,
    [PROJECT, userId, level],
  )
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  const credentialId = `00000000-0000-0000-0000-${String(++nextCred).padStart(12, '0')}`
  await tdb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id)
     VALUES ($1, $2, 'test', $3, $4, 'act', NULL, $5)`,
    [credentialId, String(userId), tokenPrefix, tokenHash, PROJECT],
  )
  return token
}

async function prepare(env: ReturnType<typeof makeEnv>, token: string, commands: unknown[]) {
  const res = (await handleExternalChangesetsRequest(
    new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands }),
    }),
    env,
  ))!
  return { res, body: (await res.json()) as any }
}

async function commit(env: ReturnType<typeof makeEnv>, token: string, id: string) {
  const res = (await handleExternalChangesetsRequest(
    new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets/${id}/commit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }),
    env,
  ))!
  return { res, body: (await res.json()) as any }
}

/** Write the project settings blob (the two dynamic gates read it). */
async function setSettings(tdb: TestDb, settings: Record<string, unknown>): Promise<void> {
  await tdb.pg.query(
    `INSERT INTO project_settings (project_id, settings, version) VALUES ($1, $2, 1)
     ON CONFLICT (project_id) DO UPDATE SET settings = EXCLUDED.settings`,
    [PROJECT, JSON.stringify(settings)],
  )
}

let tdb: TestDb
beforeEach(async () => {
  nextUserId = 700
  tdb = await makeTestDb({
    projects: [{ id: PROJECT, name: 'P', created_by: 98, org_id: null }],
    files: [{ id: FILE, project_id: PROJECT, name: 'Episode 1', event_id: 'f-evt-1' }],
    cells: [
      {
        project_id: PROJECT, file_id: FILE, cell_id: 'cell-1', side: 'source',
        value: 'source one', event_id: 'src-evt-1', last_edit_at: 1,
      },
      // A target pinned to cell-1's CURRENT source head — the AD-9 staleness
      // derivation is `source.event_id != target.source_event_id`, so this row
      // is fresh until a source commit moves the head.
      {
        project_id: PROJECT, file_id: FILE, cell_id: 'cell-1', side: 'target',
        value: 'target one', event_id: 'tgt-evt-1', source_event_id: 'src-evt-1', last_edit_at: 1,
      },
      // A media cell: `value` is the import filename, the transcript is the
      // text that actually matters (AQU-847).
      {
        project_id: PROJECT, file_id: FILE, cell_id: 'cell-2', side: 'source',
        value: 'take-07.wav', event_id: 'src-evt-2', last_edit_at: 1,
      },
    ],
  })
  // Unlocked timing by default; track editing OFF by default (its own gate is
  // switched on per-test, matching the product default).
  await setSettings(tdb, { timingLocked: false })
})

// ── validation ───────────────────────────────────────────────────────────────

describe('cell-field commands — validation', () => {
  it('accepts the four kinds through validateCommands', () => {
    const result = validateCommands([
      { kind: 'SetSource', fileId: FILE, cellId: 'cell-1', value: 'fixed' },
      { kind: 'SetTranscription', fileId: FILE, cellId: 'cell-2', transcription: 'spoken words' },
      { kind: 'SetTiming', fileId: FILE, cellId: 'cell-1', startMs: 100, endMs: 900 },
      { kind: 'SetTrackOverride', fileId: FILE, trackId: 'target-audio', patch: { name: 'Dub' } },
    ])
    expect(result.ok).toBe(true)
  })

  it('AQU-927: a fractional millisecond is REJECTED at the boundary, naming the value', () => {
    const result = validateCommands([
      { kind: 'SetTiming', fileId: FILE, cellId: 'cell-1', startMs: 2403.5, endMs: 5120 },
    ])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.issues[0].message).toContain('INTEGER')
    expect(result.issues[0].message).toContain('2403.5')
    // Nothing silently rounds: 2403.5 never becomes 2404 on this surface.
    expect(result.issues[0].message).not.toContain('2404')
  })

  it('rejects a half-specified span, an inverted span, and an empty SetTiming', () => {
    const only = validateCommands([{ kind: 'SetTiming', fileId: FILE, cellId: 'cell-1', startMs: 5 }])
    expect(only.ok).toBe(false)
    const inverted = validateCommands([
      { kind: 'SetTiming', fileId: FILE, cellId: 'cell-1', startMs: 900, endMs: 100 },
    ])
    expect(inverted.ok).toBe(false)
    const empty = validateCommands([{ kind: 'SetTiming', fileId: FILE }])
    expect(empty.ok).toBe(false)
  })

  it('rejects an unknown track-patch key and an out-of-shape trackId', () => {
    const badKey = validateCommands([
      { kind: 'SetTrackOverride', fileId: FILE, trackId: 't1', patch: { nombre: 'x' } },
    ])
    expect(badKey.ok).toBe(false)
    const badId = validateCommands([
      { kind: 'SetTrackOverride', fileId: FILE, trackId: 'not a track id!', patch: { name: 'x' } },
    ])
    expect(badId.ok).toBe(false)
  })

  it('normalizes SetSource + SetTranscription on one cell into ONE source event', () => {
    const cmds: CellFieldCommand[] = [
      { kind: 'SetSource', fileId: FILE, cellId: 'cell-1', value: 'fixed' },
      { kind: 'SetTranscription', fileId: FILE, cellId: 'cell-1', transcription: 'heard' },
    ]
    const plan = planCellFields(cmds)
    // One event, not two: `source.cell.commit` is chain-mutating, so two of
    // them on one cell would compete for a single chain slot.
    expect(plan.sourceCommits).toHaveLength(1)
    expect(plan.sourceCommits[0]).toMatchObject({ value: 'fixed', transcription: 'heard' })
    // Disjoint fields merged — nothing was dropped, so nothing is warned.
    expect(plan.warnings).toHaveLength(0)
  })

  it('warns (never silently drops) when two writes overlap on one field', () => {
    const plan = planCellFields([
      { kind: 'SetSource', fileId: FILE, cellId: 'cell-1', value: 'first' },
      { kind: 'SetSource', fileId: FILE, cellId: 'cell-1', value: 'second' },
    ])
    expect(plan.sourceCommits).toHaveLength(1)
    expect(plan.sourceCommits[0].value).toBe('second')
    expect(plan.warnings[0].code).toBe('duplicate_command')
  })
})

// ── role floors ──────────────────────────────────────────────────────────────

describe('cell-field commands — role floors', () => {
  it('SetSource sits ABOVE SetTranslation, and each floor matches its compiled event', () => {
    const setTranslation = requiredRoleForCommand({
      kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'x',
    })
    const setSource = requiredRoleForCommand({
      kind: 'SetSource', fileId: FILE, cellId: 'cell-1', value: 'x',
    })
    expect(setTranslation).toBe(ROLE.CONTRIBUTOR)
    expect(setSource).toBe(ROLE.PROJECT_LEAD)
    expect(setSource).toBeGreaterThan(setTranslation)

    expect(
      requiredRoleForCommand({ kind: 'SetTranscription', fileId: FILE, cellId: 'c', transcription: 't' }),
    ).toBe(ROLE.PROJECT_LEAD)
    expect(
      requiredRoleForCommand({ kind: 'SetTiming', fileId: FILE, cellId: 'c', startMs: 0, endMs: 1 }),
    ).toBe(ROLE.CONTRIBUTOR)
    // timingMode is a FILE-level structural change — it pulls the floor up.
    expect(requiredRoleForCommand({ kind: 'SetTiming', fileId: FILE, timingMode: 'dubbing' })).toBe(
      ROLE.MAINTAINER,
    )
    expect(
      requiredRoleForCommand({ kind: 'SetTrackOverride', fileId: FILE, trackId: 't', patch: null }),
    ).toBe(ROLE.MAINTAINER)
  })

  it('a CONTRIBUTOR — enough for SetTranslation — cannot stage a SetSource', async () => {
    const env = makeEnv(tdb.db)
    const contributor = await memberToken(tdb, ROLE.CONTRIBUTOR)

    // The same credential CAN stage the target-side write, so the refusal below
    // is about the source floor and not about membership or scope.
    const ok = await prepare(env, contributor, [
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'una traducción' },
    ])
    expect(ok.res.status).toBe(200)

    const denied = await prepare(env, contributor, [
      { kind: 'SetSource', fileId: FILE, cellId: 'cell-1', value: 'corrected source' },
    ])
    expect(denied.res.status).toBe(403)
    expect(denied.body.error.code).toBe('permission_denied')
  })

  it('a PROJECT_LEAD can stage a SetSource', async () => {
    const env = makeEnv(tdb.db)
    const lead = await memberToken(tdb, ROLE.PROJECT_LEAD)
    const { res } = await prepare(env, lead, [
      { kind: 'SetSource', fileId: FILE, cellId: 'cell-1', value: 'corrected source' },
    ])
    expect(res.status).toBe(200)
  })
})

// ── SetSource end-to-end ─────────────────────────────────────────────────────

describe('SetSource — apply', () => {
  it('updates the source and leaves the dependent target STALE (AD-9)', async () => {
    const env = makeEnv(tdb.db)
    const lead = await memberToken(tdb, ROLE.PROJECT_LEAD)

    const staged = await prepare(env, lead, [
      { kind: 'SetSource', fileId: FILE, cellId: 'cell-1', value: 'corrected source' },
    ])
    expect(staged.res.status).toBe(200)
    expect(staged.body.summary.sourceEdits).toBe(1)

    const applied = await commit(env, lead, staged.body.changeset.id)
    expect(applied.res.status).toBe(200)
    expect(applied.body.receipt.appliedCount).toBe(1)

    const rows = await tdb.rows<{
      side: string
      value: string
      event_id: string
      source_event_id: string | null
    }>('cells')
    const source = rows.find((r) => r.side === 'source' && r.value === 'corrected source')!
    const target = rows.find((r) => r.side === 'target')!
    expect(source).toBeDefined()
    // The chain head moved off the value the target was pinned to…
    expect(source.event_id).not.toBe('src-evt-1')
    // …and the target's pin did NOT move, which IS the staleness signal.
    expect(target.source_event_id).toBe('src-evt-1')
    expect(target.source_event_id).not.toBe(source.event_id)
  })

  it('a source head that moved between prepare and commit is plan_stale', async () => {
    const env = makeEnv(tdb.db)
    const lead = await memberToken(tdb, ROLE.PROJECT_LEAD)
    const staged = await prepare(env, lead, [
      { kind: 'SetSource', fileId: FILE, cellId: 'cell-1', value: 'corrected source' },
    ])
    expect(staged.res.status).toBe(200)

    // Somebody edited the source by hand in between.
    await tdb.pg.query(
      `UPDATE cells SET event_id = 'src-evt-1b' WHERE project_id = $1 AND cell_id = 'cell-1' AND side = 'source'`,
      [PROJECT],
    )

    const applied = await commit(env, lead, staged.body.changeset.id)
    expect(applied.res.status).toBe(409)
    expect(applied.body.error.code).toBe('plan_stale')
  })
})

// ── SetTranscription end-to-end ──────────────────────────────────────────────

describe('SetTranscription — apply', () => {
  it('writes the transcript without blanking the imported filename', async () => {
    const env = makeEnv(tdb.db)
    const lead = await memberToken(tdb, ROLE.PROJECT_LEAD)
    const staged = await prepare(env, lead, [
      { kind: 'SetTranscription', fileId: FILE, cellId: 'cell-2', transcription: 'and then he said' },
    ])
    expect(staged.res.status).toBe(200)
    expect(staged.body.summary.transcriptionsSet).toBe(1)
    expect(staged.body.summary.sourceEdits).toBeUndefined()

    const applied = await commit(env, lead, staged.body.changeset.id)
    expect(applied.res.status).toBe(200)

    const rows = await tdb.rows<{ cell_id: string; side: string; value: string; transcription: string | null }>('cells')
    const cell = rows.find((r) => r.cell_id === 'cell-2' && r.side === 'source')!
    expect(cell.transcription).toBe('and then he said')
    // The import record survives — this is the whole point of the
    // transcript-only path.
    expect(cell.value).toBe('take-07.wav')
  })
})

// ── SetTiming end-to-end ─────────────────────────────────────────────────────

describe('SetTiming — apply', () => {
  it('retimes a cell and the new span lands on the row', async () => {
    const env = makeEnv(tdb.db)
    const contributor = await memberToken(tdb, ROLE.CONTRIBUTOR)
    const staged = await prepare(env, contributor, [
      { kind: 'SetTiming', fileId: FILE, cellId: 'cell-1', startMs: 2403, endMs: 5120 },
    ])
    expect(staged.res.status).toBe(200)
    expect(staged.body.summary.cellsRetimed).toBe(1)

    const applied = await commit(env, contributor, staged.body.changeset.id)
    expect(applied.res.status).toBe(200)
    expect(applied.body.receipt.appliedCount).toBe(1)

    const rows = await tdb.rows<{ cell_id: string; start_ms: string | number | null; end_ms: string | number | null }>('cells')
    const timed = rows.filter((r) => r.cell_id === 'cell-1')
    expect(timed.some((r) => Number(r.start_ms) === 2403 && Number(r.end_ms) === 5120)).toBe(true)
  })

  it('the project timing lock raises a retime to MAINTAINER, and prepare says so', async () => {
    await setSettings(tdb, { timingLocked: true })
    const env = makeEnv(tdb.db)
    const contributor = await memberToken(tdb, ROLE.CONTRIBUTOR)
    const denied = await prepare(env, contributor, [
      { kind: 'SetTiming', fileId: FILE, cellId: 'cell-1', startMs: 10, endMs: 20 },
    ])
    expect(denied.res.status).toBe(403)
    expect(denied.body.error.code).toBe('permission_denied')
    expect(denied.body.error.message).toContain('timing is locked')

    // A maintainer clears the raised floor.
    const maintainer = await memberToken(tdb, ROLE.MAINTAINER)
    const ok = await prepare(env, maintainer, [
      { kind: 'SetTiming', fileId: FILE, cellId: 'cell-1', startMs: 10, endMs: 20 },
    ])
    expect(ok.res.status).toBe(200)
  })

  it('sets a file-level timing mode', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, ROLE.MAINTAINER)
    const staged = await prepare(env, maintainer, [
      { kind: 'SetTiming', fileId: FILE, timingMode: 'audioFirst' },
    ])
    expect(staged.res.status).toBe(200)
    expect(staged.body.summary.timingModesSet).toBe(1)

    const applied = await commit(env, maintainer, staged.body.changeset.id)
    expect(applied.res.status).toBe(200)

    const files = await tdb.rows<{ id: string; meta: unknown }>('files')
    const meta = files.find((f) => f.id === FILE)!.meta
    const parsed = (typeof meta === 'string' ? JSON.parse(meta) : meta) as { timingMode?: string }
    expect(parsed.timingMode).toBe('audioFirst')
  })
})

// ── SetTrackOverride end-to-end ──────────────────────────────────────────────

describe('SetTrackOverride — apply', () => {
  it('applies an ungated rename with track editing off', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, ROLE.MAINTAINER)
    const staged = await prepare(env, maintainer, [
      { kind: 'SetTrackOverride', fileId: FILE, trackId: 'target-audio', patch: { name: 'Dub — ES' } },
    ])
    expect(staged.res.status).toBe(200)
    expect(staged.body.summary.trackOverridesSet).toBe(1)

    const applied = await commit(env, maintainer, staged.body.changeset.id)
    expect(applied.res.status).toBe(200)

    const files = await tdb.rows<{ id: string; meta: unknown }>('files')
    const meta = files.find((f) => f.id === FILE)!.meta
    const parsed = (typeof meta === 'string' ? JSON.parse(meta) : meta) as {
      trackOverrides?: Record<string, { name?: string }>
    }
    expect(parsed.trackOverrides?.['target-audio']?.name).toBe('Dub — ES')
  })

  it('a RESTRUCTURING patch is refused while allowTrackEditing is off — even for an OWNER', async () => {
    const env = makeEnv(tdb.db)
    const owner = await memberToken(tdb, ROLE.OWNER)
    const denied = await prepare(env, owner, [
      { kind: 'SetTrackOverride', fileId: FILE, trackId: 'target-audio', patch: null },
    ])
    expect(denied.res.status).toBe(403)
    expect(denied.body.error.message).toContain('allowTrackEditing')

    // Two gates means two gates: opting the project in is what unblocks it,
    // not a higher role.
    await setSettings(tdb, { timingLocked: false, allowTrackEditing: true })
    const ok = await prepare(env, owner, [
      { kind: 'SetTrackOverride', fileId: FILE, trackId: 'target-audio', patch: null },
    ])
    expect(ok.res.status).toBe(200)
  })
})

// ── changeset hygiene ────────────────────────────────────────────────────────

describe('cell-field commands — changeset hygiene', () => {
  it('cannot be mixed with SetTranslation in one changeset', async () => {
    const env = makeEnv(tdb.db)
    const lead = await memberToken(tdb, ROLE.PROJECT_LEAD)
    const { res, body } = await prepare(env, lead, [
      { kind: 'SetSource', fileId: FILE, cellId: 'cell-1', value: 'a' },
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'b' },
    ])
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
    expect(body.error.message).toContain('cannot be mixed')
  })

  it('rejects a plan naming a cell or file that does not exist', async () => {
    const env = makeEnv(tdb.db)
    const lead = await memberToken(tdb, ROLE.PROJECT_LEAD)
    const noCell = await prepare(env, lead, [
      { kind: 'SetSource', fileId: FILE, cellId: 'nope', value: 'a' },
    ])
    expect(noCell.res.status).toBe(400)
    expect(noCell.body.error.message).toContain('nope')

    // A maintainer, because SetTrackOverride's own floor would otherwise 403
    // before the existence check this case is about.
    const maintainer = await memberToken(tdb, ROLE.MAINTAINER)
    const noFile = await prepare(env, maintainer, [
      { kind: 'SetTrackOverride', fileId: 'ghost-file', trackId: 't1', patch: { name: 'x' } },
    ])
    expect(noFile.res.status).toBe(400)
    expect(noFile.body.error.message).toContain('ghost-file')
  })
})

// ── catalog parity ───────────────────────────────────────────────────────────

describe('cell-field commands — describe_command catalog', () => {
  it('documents all four, with floors matching what the engine enforces', () => {
    const expected: [string, number][] = [
      ['SetSource', ROLE.PROJECT_LEAD],
      ['SetTranscription', ROLE.PROJECT_LEAD],
      ['SetTiming', ROLE.CONTRIBUTOR],
      ['SetTrackOverride', ROLE.MAINTAINER],
    ]
    for (const [kind, floor] of expected) {
      const entry = describeCommand(kind)
      expect(entry, `${kind} is missing from the command catalog`).not.toBeNull()
      expect(entry!.minRoleLevel, `${kind} floor drifted from role-policy`).toBe(floor)
      expect(entry!.agentReachable).toBe(true)
      expect(entry!.paramsDoc.length).toBeGreaterThan(0)
    }
    // The two gotchas an agent will otherwise learn the hard way.
    expect(describeCommand('SetTiming')!.paramsDoc).toContain('INTEGER')
    expect(describeCommand('SetTrackOverride')!.paramsDoc).toContain('allowTrackEditing')
  })
})
