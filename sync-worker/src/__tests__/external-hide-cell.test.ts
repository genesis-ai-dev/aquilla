// AQU-1426: HideCell / ShowCell on the Agent API, and the `hidden` flag on
// agent-facing cell reads.
//
// Covers, per the issue's acceptance criteria:
//   - discovery: the REST discovery root, the shared command catalog (which is
//     what get_capabilities.commands and describe_command serve) and the MCP
//     prepare_translations schema all name both commands, with parameter docs
//   - a Project Lead PAT stages and applies HideCell: hidden_at lands on the
//     SOURCE row, the cell reads back `hidden: true`, and ShowCell reverses it
//   - a Contributor PAT is refused with the standard role error and the cell
//     stays visible
//   - an unknown cell, and a cell already in the state asked for, are refused
//     at prepare and stage NOTHING
//   - cell reads over REST carry an explicit `hidden` boolean per cell
//   - the applied event's provenance names the agent, the channel and the
//     changeset, like every other command
//
// Plus the regression guards the slice depends on:
//   - the raw EmitEvents door still REFUSES source.cell.visibility.set, so the
//     named commands stay the only way in (the discoverable surface is the
//     point, and the generic door was deliberately left closed)
//   - hiding is NOT chain-mutating: the source head and every target's AD-9 pin
//     are byte-identical afterwards, so no lane goes stale for a hide
//   - nothing is deleted: the target row, its text and its validation survive a
//     hide/show round trip

import { describe, it, expect, beforeEach, vi } from 'vitest'

// changesets-route → commit.ts → events/route.ts → broadcast.ts → partyserver
// (cloudflare:*) — the same mock every external suite uses.
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalChangesetsRequest } from '../external/changesets-route'
import { handleExternalReadRequest, stampCellVisibility } from '../external/read-routes'
import { handleExternalDiscoveryRequest } from '../external/discovery-route'
import { validateCommands, requiredRoleForCommand } from '../external/commands'
import {
  visibilityToEmitEvents,
  visibilityCommandFloor,
  isVisibilityCommandKind,
} from '../external/commands-hide-cell'
import {
  ALLOWED_EMIT_KINDS,
  emitKindEffectLabel,
} from '../external/commands-emit-events'
import { MCP_TOOLS } from '../external/mcp-tools'
import { describeCommand } from '../../../db/shared/command-catalog'
import { ROLE } from '../events/role-policy'
import { isChainMutatingKind } from '../events/event-projection'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const PROJECT = 'proj-hide'
const FILE = 'file-hide'
const SECRET = 'test-secret'

function makeEnv(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, BASE_URL: 'https://aquilla.app' }
}

let nextUserId = 900
let nextCred = 400

/** A project member at `level` plus an act-mode PAT scoped to this project. */
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

async function prepare(tdb: TestDb, token: string, commands: unknown[]) {
  const res = (await handleExternalChangesetsRequest(
    new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands }),
    }),
    makeEnv(tdb.db),
  ))!
  return { res, body: (await res.json()) as any }
}

async function commit(tdb: TestDb, token: string, id: string) {
  const res = (await handleExternalChangesetsRequest(
    new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets/${id}/commit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }),
    makeEnv(tdb.db),
  ))!
  return { res, body: (await res.json()) as any }
}

/** Stage + apply in one step (act-mode credentials need no confirmation). */
async function apply(tdb: TestDb, token: string, commands: unknown[]) {
  const staged = await prepare(tdb, token, commands)
  if (staged.res.status !== 200) return staged
  return commit(tdb, token, staged.body.changeset.id)
}

/** The agent-facing cells read — what an external agent actually sees. */
async function readCells(tdb: TestDb, token: string) {
  const res = (await handleExternalReadRequest(
    new Request(`https://w/api/v1/external/projects/${PROJECT}/files/${FILE}/cells`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    makeEnv(tdb.db),
  ))!
  const body = (await res.json()) as { data: Record<string, unknown>[] }
  return body.data
}

async function sourceRow(tdb: TestDb, cellId: string) {
  const rows = await tdb.rows<{
    cell_id: string
    side: string
    hidden_at: number | null
    event_id: string
    value: string | null
  }>('cells')
  return rows.find((r) => r.cell_id === cellId && r.side === 'source')!
}

let tdb: TestDb
beforeEach(async () => {
  nextUserId = 900
  tdb = await makeTestDb({
    projects: [{ id: PROJECT, name: 'P', created_by: 98, org_id: null }],
    files: [{ id: FILE, project_id: PROJECT, name: 'Mark', event_id: 'f-evt-1' }],
    cells: [
      {
        project_id: PROJECT, file_id: FILE, cell_id: 'cell-1', side: 'source',
        value: 'In the beginning', event_id: 'src-evt-1', anchor_cell_id: null, last_edit_at: 1,
      },
      // A validated translation pinned to cell-1's CURRENT source head. If a
      // hide were chain-mutating this pin would stop matching and the lane
      // would read as stale — the thing AQU-1422 designed the event NOT to do.
      {
        project_id: PROJECT, file_id: FILE, cell_id: 'cell-1', side: 'target',
        value: 'En el principio', event_id: 'tgt-evt-1', source_event_id: 'src-evt-1',
        validated: 1, anchor_cell_id: null, last_edit_at: 1,
      },
      {
        project_id: PROJECT, file_id: FILE, cell_id: 'cell-2', side: 'source',
        value: 'A stray heading', event_id: 'src-evt-2', anchor_cell_id: 'cell-1', last_edit_at: 1,
      },
    ],
  })
})

// ── discovery (AC 1) ─────────────────────────────────────────────────────────

describe('HideCell / ShowCell — discovery', () => {
  it('the REST discovery root names both command kinds', async () => {
    const res = (await handleExternalDiscoveryRequest(
      new Request('https://w/api/v1/external'),
      makeEnv(tdb.db),
    ))!
    const text = JSON.stringify(await res.json())
    expect(text).toContain('HideCell')
    expect(text).toContain('ShowCell')
  })

  it('the shared catalog documents both, with params, the floor, and the reversibility', () => {
    for (const kind of ['HideCell', 'ShowCell']) {
      const entry = describeCommand(kind)
      expect(entry, `${kind} missing from the catalog`).not.toBeNull()
      expect(entry!.agentReachable).toBe(true)
      // The floor the catalog advertises IS the floor prepare enforces.
      expect(entry!.minRoleLevel).toBe(visibilityCommandFloor())
      expect(entry!.paramsDoc).toContain('{ fileId, cellId }')
      expect(entry!.paramsDoc).toContain('source.cell.visibility.set')
    }
    // The distinction that keeps an agent from reaching for DeleteCell instead
    // has to be IN the doc an agent reads, not just in our heads.
    expect(describeCommand('HideCell')!.paramsDoc).toContain('DeleteCell')
    expect(describeCommand('HideCell')!.paramsDoc.toLowerCase()).toContain('reversible')
  })

  it('the MCP prepare_translations schema accepts both kinds', () => {
    const tool = MCP_TOOLS.find((t) => t.name === 'prepare_translations')!
    const schema = tool.inputSchema as {
      properties: { commands: { items: { oneOf: { properties: { kind: { enum: string[] } } }[] } } }
    }
    const kinds = schema.properties.commands.items.oneOf.flatMap((v) => v.properties.kind.enum)
    expect(kinds).toContain('HideCell')
    expect(kinds).toContain('ShowCell')
    // And the tool prose tells an agent which of the two tools to reach for.
    expect(tool.description).toContain('HideCell')
    expect(tool.description).toContain('DeleteCell is ')
  })

  it('read_content tells an agent what the hidden flag means', () => {
    const tool = MCP_TOOLS.find((t) => t.name === 'read_content')!
    expect(tool.description).toContain('hidden')
    expect(tool.description).toContain('ShowCell')
  })

  it('validateCommands accepts both kinds and floors them at PROJECT_LEAD', () => {
    const result = validateCommands([
      { kind: 'HideCell', fileId: FILE, cellId: 'cell-2' },
      { kind: 'ShowCell', fileId: FILE, cellId: 'cell-1' },
    ])
    expect(result.ok).toBe(true)
    expect(requiredRoleForCommand({ kind: 'HideCell', fileId: FILE, cellId: 'c' })).toBe(ROLE.PROJECT_LEAD)
    expect(requiredRoleForCommand({ kind: 'ShowCell', fileId: FILE, cellId: 'c' })).toBe(ROLE.PROJECT_LEAD)
    expect(isVisibilityCommandKind('HideCell')).toBe(true)
    expect(isVisibilityCommandKind('DeleteCell')).toBe(false)
  })

  it('rejects a missing fileId/cellId at the boundary, naming the field', () => {
    const noCell = validateCommands([{ kind: 'HideCell', fileId: FILE }])
    expect(noCell.ok).toBe(false)
    if (noCell.ok) throw new Error('unreachable')
    expect(noCell.issues[0].message).toContain('HideCell.cellId')
    const noFile = validateCommands([{ kind: 'ShowCell', cellId: 'c' }])
    expect(noFile.ok).toBe(false)
    if (noFile.ok) throw new Error('unreachable')
    expect(noFile.issues[0].message).toContain('ShowCell.fileId')
  })
})

// ── the compiled event (the perimeter contract) ──────────────────────────────

describe('HideCell / ShowCell — the compiled event', () => {
  it('desugars to source.cell.visibility.set carrying the direction', () => {
    const cmd = visibilityToEmitEvents([
      { kind: 'HideCell', fileId: FILE, cellId: 'cell-2' },
    ])
    expect(cmd).toEqual({
      kind: 'EmitEvents',
      events: [
        { kind: 'source.cell.visibility.set', fileId: FILE, cellId: 'cell-2', payload: { hidden: true } },
      ],
    })
    expect(
      visibilityToEmitEvents([{ kind: 'ShowCell', fileId: FILE, cellId: 'cell-2' }]).events[0].payload,
    ).toEqual({ hidden: false })
  })

  it('the kind is NOT on the raw EmitEvents allow-list — the named commands are the only door', () => {
    expect(ALLOWED_EMIT_KINDS).not.toContain('source.cell.visibility.set')
    const raw = validateCommands([
      {
        kind: 'EmitEvents',
        events: [
          { kind: 'source.cell.visibility.set', fileId: FILE, cellId: 'cell-2', payload: { hidden: true } },
        ],
      },
    ])
    expect(raw.ok).toBe(false)
    if (raw.ok) throw new Error('unreachable')
    expect(raw.issues[0].message).toContain('not an allowed EmitEvents kind')
  })

  it('is not chain-mutating, so no lane can go stale for a hide', () => {
    expect(isChainMutatingKind('source.cell.visibility.set')).toBe(false)
  })

  it('the approval page gets a direction-aware sentence, not a raw kind × count', () => {
    const hide = emitKindEffectLabel('source.cell.visibility.set', 2, { hidden: true })
    const show = emitKindEffectLabel('source.cell.visibility.set', 1, { hidden: false })
    expect(hide).toContain('Hide')
    expect(hide).toContain('2')
    expect(show.toLowerCase()).toContain('back')
    expect(hide).not.toBe(show)
    // Never the developer-facing fallback for a kind we DO have prose for.
    expect(hide).not.toContain('source.cell.visibility.set')
  })
})

// ── apply / reverse (AC 2) ───────────────────────────────────────────────────

describe('HideCell / ShowCell — a Project Lead applies them', () => {
  it('HideCell parks the cell and ShowCell brings it back, losing nothing', async () => {
    const lead = await memberToken(tdb, ROLE.PROJECT_LEAD)
    const before = await sourceRow(tdb, 'cell-1')
    expect(before.hidden_at).toBeNull()

    const hidden = await apply(tdb, lead, [{ kind: 'HideCell', fileId: FILE, cellId: 'cell-1' }])
    expect(hidden.res.status).toBe(200)
    expect(hidden.body.receipt.appliedCount).toBe(1)

    const parked = await sourceRow(tdb, 'cell-1')
    expect(parked.hidden_at).not.toBeNull()
    // AD-9: the source head did NOT move, so the validated translation pinned to
    // it is still fresh. This is the assertion that fails if anyone ever makes
    // the event chain-mutating.
    expect(parked.event_id).toBe(before.event_id)
    expect(parked.value).toBe(before.value)

    const rows = await tdb.rows<{
      cell_id: string; side: string; value: string | null; validated: number | null
      source_event_id: string | null; hidden_at: number | null
    }>('cells')
    const target = rows.find((r) => r.cell_id === 'cell-1' && r.side === 'target')!
    // Nothing was deleted and nothing was re-pinned: text, validation and the
    // AD-9 pin are all as they were.
    expect(target.value).toBe('En el principio')
    expect(Number(target.validated)).toBe(1)
    expect(target.source_event_id).toBe('src-evt-1')
    // The flag lives on the source row ONLY — hiding is per cell, not per lane.
    expect(target.hidden_at).toBeNull()

    const shown = await apply(tdb, lead, [{ kind: 'ShowCell', fileId: FILE, cellId: 'cell-1' }])
    expect(shown.res.status).toBe(200)
    const restored = await sourceRow(tdb, 'cell-1')
    expect(restored.hidden_at).toBeNull()
    expect(restored.event_id).toBe(before.event_id)
  })

  it('stages several hides in one changeset and applies them all', async () => {
    const lead = await memberToken(tdb, ROLE.PROJECT_LEAD)
    const out = await apply(tdb, lead, [
      { kind: 'HideCell', fileId: FILE, cellId: 'cell-1' },
      { kind: 'HideCell', fileId: FILE, cellId: 'cell-2' },
    ])
    expect(out.res.status).toBe(200)
    expect(out.body.receipt.appliedCount).toBe(2)
    expect((await sourceRow(tdb, 'cell-1')).hidden_at).not.toBeNull()
    expect((await sourceRow(tdb, 'cell-2')).hidden_at).not.toBeNull()
  })

  it("the applied event's provenance names the agent, the channel and the changeset (AC 6)", async () => {
    const lead = await memberToken(tdb, ROLE.PROJECT_LEAD)
    const staged = await prepare(tdb, lead, [{ kind: 'HideCell', fileId: FILE, cellId: 'cell-2' }])
    const changesetId = staged.body.changeset.id as string
    await commit(tdb, lead, changesetId)

    const events = await tdb.rows<{ kind: string; provenance: unknown }>('events')
    const hide = events.find((e) => e.kind === 'source.cell.visibility.set')!
    expect(hide).toBeDefined()
    const prov = (
      typeof hide.provenance === 'string' ? JSON.parse(hide.provenance) : hide.provenance
    ) as Record<string, unknown>
    expect(prov.origin).toBe('agent')
    expect(prov.changeset_id).toBe(changesetId)
    expect(prov.channel).toBe('rest')
    // The human whose authority the agent is borrowing is named too.
    expect((prov.human_authority as Record<string, unknown>).credential_id).toBeTruthy()
  })
})

// ── the role gate (AC 3) ─────────────────────────────────────────────────────

describe('HideCell / ShowCell — the role gate', () => {
  it('a Contributor PAT is refused and the cell stays visible', async () => {
    const contributor = await memberToken(tdb, ROLE.CONTRIBUTOR)
    const out = await prepare(tdb, contributor, [{ kind: 'HideCell', fileId: FILE, cellId: 'cell-1' }])
    expect(out.res.status).toBe(403)
    expect(out.body.error.code).toBe('permission_denied')
    // Nothing staged, nothing applied — the row is untouched.
    expect((await sourceRow(tdb, 'cell-1')).hidden_at).toBeNull()
    expect(await tdb.rows('changesets')).toHaveLength(0)
  })

  it('a Commenter is refused too — the floor is PROJECT_LEAD, not "can comment"', async () => {
    const commenter = await memberToken(tdb, ROLE.COMMENTER)
    const out = await prepare(tdb, commenter, [{ kind: 'ShowCell', fileId: FILE, cellId: 'cell-1' }])
    expect(out.res.status).toBe(403)
    expect((await sourceRow(tdb, 'cell-1')).hidden_at).toBeNull()
  })
})

// ── preconditions (AC 4) ─────────────────────────────────────────────────────

describe('HideCell / ShowCell — preconditions', () => {
  it('refuses an unknown cell and stages nothing', async () => {
    const lead = await memberToken(tdb, ROLE.PROJECT_LEAD)
    const out = await prepare(tdb, lead, [{ kind: 'HideCell', fileId: FILE, cellId: 'no-such-cell' }])
    expect(out.res.status).toBe(400)
    expect(out.body.error.code).toBe('validation_failed')
    expect(out.body.error.message).toContain('no-such-cell')
    expect(await tdb.rows('changesets')).toHaveLength(0)
  })

  it('refuses HideCell on an already-hidden cell, and ShowCell on a visible one', async () => {
    const lead = await memberToken(tdb, ROLE.PROJECT_LEAD)
    // ShowCell on a cell nobody hid: a plan whose whole effect is nothing.
    const show = await prepare(tdb, lead, [{ kind: 'ShowCell', fileId: FILE, cellId: 'cell-1' }])
    expect(show.res.status).toBe(400)
    expect(show.body.error.message).toContain('is not hidden')

    await apply(tdb, lead, [{ kind: 'HideCell', fileId: FILE, cellId: 'cell-1' }])
    const again = await prepare(tdb, lead, [{ kind: 'HideCell', fileId: FILE, cellId: 'cell-1' }])
    expect(again.res.status).toBe(400)
    expect(again.body.error.message).toContain('already hidden')
  })

  it('refuses a plan that mixes hides with shows, or names one cell twice', async () => {
    const lead = await memberToken(tdb, ROLE.PROJECT_LEAD)
    await apply(tdb, lead, [{ kind: 'HideCell', fileId: FILE, cellId: 'cell-1' }])

    const mixed = await prepare(tdb, lead, [
      { kind: 'ShowCell', fileId: FILE, cellId: 'cell-1' },
      { kind: 'HideCell', fileId: FILE, cellId: 'cell-2' },
    ])
    expect(mixed.res.status).toBe(400)
    expect(mixed.body.error.message).toContain('two plans')

    const twice = await prepare(tdb, lead, [
      { kind: 'HideCell', fileId: FILE, cellId: 'cell-2' },
      { kind: 'HideCell', fileId: FILE, cellId: 'cell-2' },
    ])
    expect(twice.res.status).toBe(400)
    expect(twice.body.error.message).toContain('twice')
  })

  it('refuses mixing with another command kind', async () => {
    const lead = await memberToken(tdb, ROLE.PROJECT_LEAD)
    const out = await prepare(tdb, lead, [
      { kind: 'HideCell', fileId: FILE, cellId: 'cell-2' },
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'x' },
    ])
    expect(out.res.status).toBe(400)
    expect(out.body.error.message).toContain('cannot be mixed')
  })

  it('a cell deleted between prepare and commit makes the plan stale, not a no-op event', async () => {
    const lead = await memberToken(tdb, ROLE.PROJECT_LEAD)
    const staged = await prepare(tdb, lead, [{ kind: 'HideCell', fileId: FILE, cellId: 'cell-2' }])
    expect(staged.res.status).toBe(200)
    await tdb.pg.query(`DELETE FROM cells WHERE project_id = $1 AND cell_id = 'cell-2'`, [PROJECT])

    const out = await commit(tdb, lead, staged.body.changeset.id)
    expect(out.res.status).toBe(409)
    expect(out.body.error.code).toBe('plan_stale')
    expect(out.body.error.message).toContain('cell-2')
  })
})

// ── reads (AC 5) ─────────────────────────────────────────────────────────────

describe('cell reads carry an explicit hidden flag', () => {
  it('shows hidden: true for the parked cell and hidden: false for the rest', async () => {
    const lead = await memberToken(tdb, ROLE.PROJECT_LEAD)
    await apply(tdb, lead, [{ kind: 'HideCell', fileId: FILE, cellId: 'cell-2' }])

    const cells = await readCells(tdb, lead)
    const byCellAndSide = (cellId: string, side: string) =>
      cells.find((c) => c.cellId === cellId && c.side === side)!

    expect(byCellAndSide('cell-2', 'source').hidden).toBe(true)
    expect(byCellAndSide('cell-1', 'source').hidden).toBe(false)
    // Explicit `false`, never an absent key: on the agent surface an absent key
    // is indistinguishable from "this server does not know about hiding".
    expect(Object.prototype.hasOwnProperty.call(byCellAndSide('cell-1', 'source'), 'hidden')).toBe(true)
    // A cell's visibility resolves per CELL, so the parked cell's other rows
    // agree with its source row rather than making the agent join them.
    expect(byCellAndSide('cell-1', 'target').hidden).toBe(false)
  })

  it('a target row of a hidden cell reads hidden: true (resolved from the source row)', () => {
    const stamped = stampCellVisibility([
      { cellId: 'c1', side: 'source', hidden: true },
      { cellId: 'c1', side: 'target', targetLang: 'es' },
      { cellId: 'c2', side: 'source' },
      { cellId: 'c2', side: 'target', targetLang: 'es' },
    ]) as Record<string, unknown>[]
    expect(stamped.map((r) => r.hidden)).toEqual([true, true, false, false])
  })

  it('leaves the key OFF a lone target row whose source row is not in the payload', () => {
    // A `since=` delta read can carry a target row alone. Asserting `false`
    // there would be reporting a visibility this response never read.
    const stamped = stampCellVisibility([
      { cellId: 'c1', side: 'source', hidden: true },
      { cellId: 'c9', side: 'target', targetLang: 'es' },
    ]) as Record<string, unknown>[]
    expect(stamped[0].hidden).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(stamped[1], 'hidden')).toBe(false)
  })

  it('passes a payload with no source rows through untouched', () => {
    const rows = [{ cellId: 'c1', side: 'target' }]
    expect(stampCellVisibility(rows)).toEqual(rows)
  })
})
