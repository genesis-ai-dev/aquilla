// Agent-callable export — the mirror of the artifact import tools (AQU-858).
//
//   GET /api/v1/external/projects/:projectId/files/:fileId/export
//   MCP tool export_file
//
// Covers the REAL composition rather than a mock of it: a USFM file with its
// original bytes preserved in file_source_blobs, source cells carrying
// canonical refs, and target cells holding translations are seeded into the
// PGlite test database, then pulled back out through the external route with a
// real PAT. What is asserted is what an agent would actually receive — the
// substituted USFM text, the fidelity headers, the lane selection — plus the
// gates: the org export floor (a contributor who may READ may not EXPORT),
// credential scope, a file with no preserved artifact, and the MCP tool's
// binary/oversize refusals that hand the caller back to REST.

import { describe, it, expect, beforeEach, vi } from 'vitest'

// mcp-route → changesets-route → commit.ts → events/route.ts → broadcast.ts
// reaches partyserver, which imports cloudflare:* — unavailable under node.
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalExportRequest } from '../external/export-route'
import { handleExportSourceRequest } from '../events/export-route'
import { handleExternalMcpRequest } from '../external/mcp-route'
import { handleExternalReadRequest } from '../external/read-routes'
import { handleExternalDiscoveryRequest } from '../external/discovery-route'
import { MCP_EXPORT_MAX_BYTES } from '../external/mcp-handlers'
import { MCP_TOOLS } from '../external/mcp-tools'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { recordRateLimitEvent } from '../../../db/shared/rate-limit'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'

const PROJECT = 'proj-export'
const OTHER_PROJECT = 'proj-other'
const FILE = 'file-gen'
const SECRET = 'test-secret'

const CRED_MAINTAINER = '00000000-0000-0000-0000-0000000000c1'
const CRED_CONTRIBUTOR = '00000000-0000-0000-0000-0000000000c2'
const CRED_OTHER_SCOPE = '00000000-0000-0000-0000-0000000000c3'

const USFM_SOURCE = [
  '\\id GEN Test Bible',
  '\\h Genesis',
  '\\c 1',
  '\\p',
  '\\v 1 In the beginning God created the heavens and the earth.',
  '\\v 2 And the earth was without form, and void.',
  '',
].join('\n')

// ── R2 stub (same shape as the other external suites) ────────────────────────

function makeStubBucket() {
  const store = new Map<string, ArrayBuffer>()
  return {
    async get(key: string) {
      const obj = store.get(key)
      if (!obj) return null
      return { arrayBuffer: async () => obj }
    },
    async put(key: string, value: ArrayBuffer | Uint8Array | string) {
      const body =
        typeof value === 'string'
          ? new TextEncoder().encode(value).buffer
          : value instanceof Uint8Array
            ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
            : value
      store.set(key, body as ArrayBuffer)
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k)
    },
  }
}

let tdb: TestDb
let bucket: ReturnType<typeof makeStubBucket>

function makeEnv() {
  return {
    AQUILLA_PG: tdb.db,
    SYNC_SECRET_KEY: SECRET,
    BASE_URL: 'https://aquilla.app',
    SNAPSHOTS: bucket as unknown as R2Bucket,
  }
}

// ── seeding ──────────────────────────────────────────────────────────────────

async function credToken(spec: {
  credentialId: string
  userId: number
  username: string
  projectId: string | null
}): Promise<string> {
  await tdb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, 'h')
     ON CONFLICT (id) DO NOTHING`,
    [spec.userId, spec.username, `${spec.username}@x.com`],
  )
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  await tdb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id)
     VALUES ($1, $2, 'test', $3, $4, 'act', NULL, $5)`,
    [spec.credentialId, String(spec.userId), tokenPrefix, tokenHash, spec.projectId],
  )
  return token
}

/** Seed a file whose ORIGINAL bytes are preserved, with one translated verse
 *  in the default lane and a different rendering of the same verse in the "es"
 *  lane, so lane selection is observable in the exported text. */
async function seedUsfmFile(opts: { format?: string; rawSource?: string | null; r2Key?: string } = {}) {
  const format = opts.format ?? 'usfm'
  await tdb.pg.query(
    `INSERT INTO files (id, project_id, name, event_id) VALUES ($1, $2, $3, 'ev-file')`,
    [FILE, PROJECT, 'GEN.SFM'],
  )
  await tdb.pg.query(
    `INSERT INTO file_source_blobs (file_id, project_id, format, raw_source, r2_key, created_at)
     VALUES ($1, $2, $3, $4, $5, 0)`,
    [FILE, PROJECT, format, opts.rawSource === undefined ? USFM_SOURCE : opts.rawSource, opts.r2Key ?? null],
  )
  const cell = async (
    cellId: string,
    side: 'source' | 'target',
    value: string,
    canonicalRef: string | null,
    lane = '',
  ) =>
    tdb.pg.query(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at, target_lang)
       VALUES ($1, $2, $3, $4, $5, $6, 'ev-cell', 0, $7)`,
      [PROJECT, FILE, cellId, side, value, canonicalRef, lane],
    )
  await cell('GEN 1:1', 'source', 'In the beginning God created the heavens and the earth.', 'GEN 1:1')
  await cell('GEN 1:2', 'source', 'And the earth was without form, and void.', 'GEN 1:2')
  await cell('GEN 1:1', 'target', 'Au commencement Dieu créa les cieux et la terre.', null)
  await cell('GEN 1:1', 'target', 'En el principio creó Dios los cielos y la tierra.', null, 'es')
}

beforeEach(async () => {
  tdb = await makeTestDb({
    projects: [
      { id: PROJECT, name: 'P', created_by: 99, org_id: null },
      { id: OTHER_PROJECT, name: 'O', created_by: 99, org_id: null },
    ],
    project_members: [
      { project_id: PROJECT, user_id: 1, role_level: 600 }, // maintainer
      { project_id: PROJECT, user_id: 2, role_level: 400 }, // contributor
      { project_id: PROJECT, user_id: 3, role_level: 600 }, // maintainer, wrong scope
    ],
  })
  bucket = makeStubBucket()
})

function exportReq(
  token: string,
  opts: { lane?: string; side?: string; fileId?: string; method?: string } = {},
): Request {
  const params = new URLSearchParams()
  if (opts.side !== undefined) params.set('side', opts.side)
  if (opts.lane !== undefined) params.set('lane', opts.lane)
  const query = params.toString() === '' ? '' : `?${params.toString()}`
  return new Request(
    `https://w/api/v1/external/projects/${PROJECT}/files/${opts.fileId ?? FILE}/export${query}`,
    { method: opts.method ?? 'GET', headers: { Authorization: `Bearer ${token}` } },
  )
}

// ── AQU-1454 fixture: a file whose CURATED SOURCE differs from both its
// original upload and its translation, so "which side came back" is decided by
// the bytes rather than by a header alone.
//
//   GEN 1:1 — imported, untouched  → must survive byte-for-byte, footnote and all
//   GEN 1:2 — imported, then HIDDEN → must leave the file entirely
//   GEN 1:3 — imported, then EDITED → must carry the CORRECTED source text
//
// Every verse also carries a translation, so a source export that leaked one is
// unmissable.

const CURATED_FILE = 'file-curated'

const CURATED_ORIGINAL = [
  '\\id GEN Test Bible',
  '\\c 1',
  '\\v 1 In the beginning God created\\f + \\fr 1.1 \\ft Or: when God began.\\f* the heavens.',
  '\\v 2 Now the earth was formless and empty.',
  '\\v 3 And God said, Let there be light.',
  '',
].join('\n')

const EDITED_SOURCE_V3 = 'And God said: Let there be light!'

async function seedCuratedSourceFile(format = 'usfm') {
  await tdb.pg.query(
    `INSERT INTO files (id, project_id, name, event_id) VALUES ($1, $2, $3, 'ev-file-curated')`,
    [CURATED_FILE, PROJECT, 'GEN.SFM'],
  )
  await tdb.pg.query(
    `INSERT INTO file_source_blobs (file_id, project_id, format, raw_source, r2_key, created_at)
     VALUES ($1, $2, $3, $4, NULL, 0)`,
    [CURATED_FILE, PROJECT, format, CURATED_ORIGINAL],
  )

  // The projection records each cell's winning event on `cells.event_id`; the
  // source plan reads that head's KIND to tell an edited verse from an
  // imported one, so the events have to be here for real.
  let seq = 0
  const event = async (id: string, kind: string, cellId: string) => {
    seq += 1
    await tdb.pg.query(
      `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, kind, author, payload,
                           client_ts, server_ts, server_seq)
       VALUES ($1, 1, $2, $3, $4, $5, 'alice', '{}', 1, 1, $6)`,
      [id, PROJECT, CURATED_FILE, cellId, kind, seq],
    )
  }
  await event('ev-c1-create', 'source.cell.create', 'GEN 1:1')
  await event('ev-c2-create', 'source.cell.create', 'GEN 1:2')
  await event('ev-c3-commit', 'source.cell.commit', 'GEN 1:3')

  const sourceCell = async (
    cellId: string,
    value: string,
    eventId: string,
    hiddenAt: number | null = null,
  ) =>
    tdb.pg.query(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id,
                          last_edit_at, target_lang, hidden_at)
       VALUES ($1, $2, $3, 'source', $4, $3, $5, 0, '', $6)`,
      [PROJECT, CURATED_FILE, cellId, value, eventId, hiddenAt],
    )
  await sourceCell('GEN 1:1', 'In the beginning God created the heavens.', 'ev-c1-create')
  await sourceCell('GEN 1:2', 'Now the earth was formless and empty.', 'ev-c2-create', 1700000000001)
  await sourceCell('GEN 1:3', EDITED_SOURCE_V3, 'ev-c3-commit')

  for (const [cellId, value] of [
    ['GEN 1:1', 'TRANSLATION ONE'],
    ['GEN 1:2', 'TRANSLATION TWO'],
    ['GEN 1:3', 'TRANSLATION THREE'],
  ] as const) {
    await tdb.pg.query(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id,
                          last_edit_at, target_lang)
       VALUES ($1, $2, $3, 'target', $4, NULL, 'ev-t', 0, '')`,
      [PROJECT, CURATED_FILE, cellId, value],
    )
  }
}

async function errorBody(res: Response): Promise<{ code: string; message: string }> {
  const body = (await res.json()) as { error: { code: string; message: string } }
  return body.error
}

// ── REST ─────────────────────────────────────────────────────────────────────

describe('GET .../files/:fileId/export (REST)', () => {
  it('reconstructs the original USFM with the current translation substituted in', async () => {
    await seedUsfmFile()
    const token = await credToken({
      credentialId: CRED_MAINTAINER,
      userId: 1,
      username: 'maint',
      projectId: PROJECT,
    })

    const res = (await handleExternalExportRequest(exportReq(token), makeEnv()))!
    expect(res.status).toBe(200)
    const text = await res.text()

    // Translated verse substituted; untranslated verse keeps its source text so
    // the delivered file stays valid USFM.
    expect(text).toContain('Au commencement Dieu créa les cieux et la terre.')
    expect(text).toContain('And the earth was without form, and void.')
    // Structure preserved (this is a round trip of the original, not a dump).
    expect(text).toContain('\\id GEN')
    expect(text).toContain('\\c 1')

    expect(res.headers.get('Content-Type')).toContain('text/plain')
    expect(res.headers.get('Content-Disposition')).toContain('GEN.SFM')
    // 0 = clean round trip; the header must survive the external hop, since it
    // is how an agent learns the export dropped intra-verse markers.
    expect(res.headers.get('X-Usfm-Lossy-Verse-Count')).toBe('0')
  })

  it('exports the requested target-language lane', async () => {
    await seedUsfmFile()
    const token = await credToken({
      credentialId: CRED_MAINTAINER,
      userId: 1,
      username: 'maint',
      projectId: PROJECT,
    })

    const es = (await handleExternalExportRequest(exportReq(token, { lane: 'es' }), makeEnv()))!
    const text = await es.text()
    expect(text).toContain('En el principio creó Dios los cielos y la tierra.')
    expect(text).not.toContain('Au commencement')
  })

  it('denies a contributor: export is gated above reading (org floor = MAINTAINER)', async () => {
    await seedUsfmFile()
    const token = await credToken({
      credentialId: CRED_CONTRIBUTOR,
      userId: 2,
      username: 'contrib',
      projectId: PROJECT,
    })

    const res = (await handleExternalExportRequest(exportReq(token), makeEnv()))!
    expect(res.status).toBe(403)
    expect((await errorBody(res)).code).toBe('permission_denied')
  })

  it('honours an org floor lowered below maintainer', async () => {
    await tdb.pg.query(`INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Org', 99)`)
    await tdb.pg.query(`UPDATE projects SET org_id = 1 WHERE id = $1`, [PROJECT])
    await tdb.pg.query(`INSERT INTO org_settings (org_id, settings) VALUES (1, $1)`, [
      JSON.stringify({ exportMinRole: 400 }),
    ])
    await seedUsfmFile()
    const token = await credToken({
      credentialId: CRED_CONTRIBUTOR,
      userId: 2,
      username: 'contrib',
      projectId: PROJECT,
    })

    const res = (await handleExternalExportRequest(exportReq(token), makeEnv()))!
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Au commencement')
  })

  it('rejects a credential scoped to another project', async () => {
    await seedUsfmFile()
    const token = await credToken({
      credentialId: CRED_OTHER_SCOPE,
      userId: 3,
      username: 'other',
      projectId: OTHER_PROJECT,
    })

    const res = (await handleExternalExportRequest(exportReq(token), makeEnv()))!
    expect(res.status).toBe(403)
    expect((await errorBody(res)).code).toBe('scope_denied')
  })

  it('401s an unauthenticated call', async () => {
    await seedUsfmFile()
    const res = (await handleExternalExportRequest(
      new Request(`https://w/api/v1/external/projects/${PROJECT}/files/${FILE}/export`),
      makeEnv(),
    ))!
    expect(res.status).toBe(401)
    expect((await errorBody(res)).code).toBe('permission_denied')
  })

  it('404s a file whose original artifact was never preserved', async () => {
    await tdb.pg.query(
      `INSERT INTO files (id, project_id, name, event_id) VALUES ($1, $2, 'orphan.txt', 'ev-file')`,
      ['file-orphan', PROJECT],
    )
    const token = await credToken({
      credentialId: CRED_MAINTAINER,
      userId: 1,
      username: 'maint',
      projectId: PROJECT,
    })

    const res = (await handleExternalExportRequest(exportReq(token, { fileId: 'file-orphan' }), makeEnv()))!
    expect(res.status).toBe(404)
    const err = await errorBody(res)
    expect(err.code).toBe('not_found')
    // The internal route's actionable message survives the mapping.
    expect(err.message).toContain('re-import')
  })

  it('405s a non-GET on the export path', async () => {
    await seedUsfmFile()
    const token = await credToken({
      credentialId: CRED_MAINTAINER,
      userId: 1,
      username: 'maint',
      projectId: PROJECT,
    })
    const res = (await handleExternalExportRequest(exportReq(token, { method: 'POST' }), makeEnv()))!
    expect(res.status).toBe(405)
  })

  it('throttles on its own budget, not the cheap-read budget', async () => {
    await seedUsfmFile()
    const token = await credToken({
      credentialId: CRED_MAINTAINER,
      userId: 1,
      username: 'maint',
      projectId: PROJECT,
    })

    // Spending the whole plain-read budget must not touch export: an export
    // streams a whole file out of R2 and gets the tighter heavy-egress cap.
    for (let i = 0; i < 300; i++) {
      await recordRateLimitEvent(tdb.db, 'external_read', `credential:${CRED_MAINTAINER}`)
    }
    expect((await handleExternalExportRequest(exportReq(token), makeEnv()))!.status).toBe(200)

    for (let i = 0; i < 120; i++) {
      await recordRateLimitEvent(tdb.db, 'external_export', `credential:${CRED_MAINTAINER}`)
    }
    const limited = (await handleExternalExportRequest(exportReq(token), makeEnv()))!
    expect(limited.status).toBe(429)
    expect((await errorBody(limited)).code).toBe('rate_limited')
  })

  it('does not claim paths it should not, and no other external handler claims its own', async () => {
    const cells = await handleExternalExportRequest(
      new Request(`https://w/api/v1/external/projects/${PROJECT}/files/${FILE}/cells`),
      makeEnv(),
    )
    expect(cells).toBeNull()

    // The read tier must decline /export, or dispatch order in index.ts would
    // silently decide which handler wins.
    const exported = await handleExternalReadRequest(
      new Request(`https://w/api/v1/external/projects/${PROJECT}/files/${FILE}/export`),
      makeEnv(),
    )
    expect(exported).toBeNull()
  })
})

// ── AQU-1454: ?side=source ────────────────────────────────────────────────────

describe('GET .../files/:fileId/export?side=source (REST)', () => {
  const maintainer = () =>
    credToken({ credentialId: CRED_MAINTAINER, userId: 1, username: 'maint', projectId: PROJECT })

  it('returns the curated source: edits applied, hidden cells removed, no translation', async () => {
    await seedCuratedSourceFile()
    const token = await maintainer()

    const res = (await handleExternalExportRequest(
      exportReq(token, { side: 'source', fileId: CURATED_FILE }),
      makeEnv(),
    ))!
    expect(res.status).toBe(200)
    const text = await res.text()

    // The edited verse carries its CORRECTED source text...
    expect(text).toContain(EDITED_SOURCE_V3)
    expect(text).not.toContain('And God said, Let there be light.')
    // ...the hidden verse has left the file, marker and all...
    expect(text).not.toContain('Now the earth was formless')
    expect(text).not.toContain('\\v 2')
    // ...the untouched verse survives byte-for-byte, footnote included...
    expect(text).toContain('\\v 1 In the beginning God created\\f + \\fr 1.1 \\ft Or: when God began.\\f* the heavens.')
    // ...and not one word of translation rides along.
    expect(text).not.toContain('TRANSLATION')

    // The header is how an agent proves which side it got.
    expect(res.headers.get('X-Export-Side')).toBe('source')
    expect(res.headers.get('Content-Disposition')).toContain('GEN.SFM')
  })

  it('is byte-identical to the in-app source download for the same file', async () => {
    await seedCuratedSourceFile()
    const token = await maintainer()

    // The in-app download: the internal route the SPA calls, with a sync-token
    // for a maintainer. If the external hop ever re-implemented the overlay
    // rather than delegating, these two would drift apart silently.
    const internalToken = await makeTestToken(SECRET, {
      userId: 1,
      username: 'maint',
      projectId: PROJECT,
      fileId: CURATED_FILE,
      role: 600,
    })
    const inApp = (await handleExportSourceRequest(
      new Request(
        `https://w/api/v1/projects/${PROJECT}/files/${CURATED_FILE}/source?side=source`,
        { headers: { Authorization: `Bearer ${internalToken}` } },
      ),
      makeEnv(),
    ))!
    expect(inApp.status).toBe(200)

    const viaAgent = (await handleExternalExportRequest(
      exportReq(token, { side: 'source', fileId: CURATED_FILE }),
      makeEnv(),
    ))!
    expect(await viaAgent.text()).toBe(await inApp.text())
  })

  it('leaves the target side exactly as it is when side is omitted or target', async () => {
    await seedCuratedSourceFile()
    const token = await maintainer()

    const omitted = (await handleExternalExportRequest(
      exportReq(token, { fileId: CURATED_FILE }),
      makeEnv(),
    ))!
    const explicit = (await handleExternalExportRequest(
      exportReq(token, { side: 'target', fileId: CURATED_FILE }),
      makeEnv(),
    ))!
    expect(omitted.status).toBe(200)
    expect(explicit.status).toBe(200)

    const omittedText = await omitted.text()
    expect(await explicit.text()).toBe(omittedText)
    // Today's contract: translations substituted, and the curated source's
    // edit is NOT smuggled in alongside them.
    expect(omittedText).toContain('TRANSLATION ONE')
    expect(omittedText).not.toContain(EDITED_SOURCE_V3)
    // A target response says nothing about a side, exactly as before.
    expect(omitted.headers.get('X-Export-Side')).toBeNull()
  })

  it('rejects any other side value, naming the two that are accepted', async () => {
    await seedCuratedSourceFile()
    const token = await maintainer()

    for (const side of ['both', 'SOURCE', '']) {
      const res = (await handleExternalExportRequest(
        exportReq(token, { side, fileId: CURATED_FILE }),
        makeEnv(),
      ))!
      expect(res.status).toBe(400)
      const err = await errorBody(res)
      expect(err.code).toBe('validation_failed')
      expect(err.message).toContain('"source"')
      expect(err.message).toContain('"target"')
    }
  })

  it('refuses side=source on a format that has no source serializer, naming the format', async () => {
    await bucket.put('blob/docx-curated', new TextEncoder().encode('PKbinary'))
    await tdb.pg.query(
      `INSERT INTO files (id, project_id, name, event_id) VALUES ($1, $2, 'DECK.docx', 'ev-f')`,
      ['file-docx', PROJECT],
    )
    await tdb.pg.query(
      `INSERT INTO file_source_blobs (file_id, project_id, format, raw_source, r2_key, created_at)
       VALUES ($1, $2, 'docx', NULL, 'blob/docx-curated', 0)`,
      ['file-docx', PROJECT],
    )
    const token = await maintainer()

    const res = (await handleExternalExportRequest(
      exportReq(token, { side: 'source', fileId: 'file-docx' }),
      makeEnv(),
    ))!
    // A clear 4xx naming the format — never the raw side-car under the source's name.
    expect(res.status).toBe(400)
    const err = await errorBody(res)
    expect(err.code).toBe('validation_failed')
    expect(err.message).toContain('docx')

    // ...while the target side still serves those bytes as it always has.
    const target = (await handleExternalExportRequest(
      exportReq(token, { fileId: 'file-docx' }),
      makeEnv(),
    ))!
    expect(target.status).toBe(200)
    expect(target.headers.get('X-Export-Mode')).toBe('raw-sidecar')
  })

  it('gates side=source behind the same export floor as the target side', async () => {
    await seedCuratedSourceFile()
    const token = await credToken({
      credentialId: CRED_CONTRIBUTOR,
      userId: 2,
      username: 'contrib',
      projectId: PROJECT,
    })

    const res = (await handleExternalExportRequest(
      exportReq(token, { side: 'source', fileId: CURATED_FILE }),
      makeEnv(),
    ))!
    expect(res.status).toBe(403)
    expect((await errorBody(res)).code).toBe('permission_denied')
  })

  it('does not spend the export budget on a request that names a side that does not exist', async () => {
    await seedCuratedSourceFile()
    const token = await maintainer()

    const before = (await handleExternalExportRequest(
      exportReq(token, { side: 'both', fileId: CURATED_FILE }),
      makeEnv(),
    ))!
    expect(before.status).toBe(400)

    const events = await tdb.rows<{ kind: string }>('auth_rate_limit_events')
    expect(events.filter((e) => e.kind === 'external_export')).toHaveLength(0)
  })
})

// ── MCP ──────────────────────────────────────────────────────────────────────

async function callMcpTool(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ payload: Record<string, unknown>; isError: boolean }> {
  const res = (await handleExternalMcpRequest(
    new Request('https://w/api/v1/external/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }),
    makeEnv(),
  ))!
  const body = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } }
  return {
    payload: JSON.parse(body.result.content[0].text) as Record<string, unknown>,
    isError: body.result.isError === true,
  }
}

describe('export_file (MCP)', () => {
  it('returns the exported text inline with its fidelity fields', async () => {
    await seedUsfmFile()
    const token = await credToken({
      credentialId: CRED_MAINTAINER,
      userId: 1,
      username: 'maint',
      projectId: PROJECT,
    })

    const { payload, isError } = await callMcpTool(token, 'export_file', {
      projectId: PROJECT,
      fileId: FILE,
    })
    expect(isError).toBe(false)
    expect(payload.fileName).toBe('GEN.SFM')
    expect(payload.exportMode).toBe('round-trip')
    expect(payload.lossyVerseCount).toBe(0)
    expect(String(payload.content)).toContain('Au commencement Dieu créa les cieux et la terre.')
    expect(payload.bytes).toBe(new TextEncoder().encode(String(payload.content)).length)
    // A clean round trip carries no "these are untranslated original bytes" warning.
    expect(payload.warning).toBeUndefined()
  })

  it('surfaces the same permission_denied code the REST route returns', async () => {
    await seedUsfmFile()
    const token = await credToken({
      credentialId: CRED_CONTRIBUTOR,
      userId: 2,
      username: 'contrib',
      projectId: PROJECT,
    })

    const { payload, isError } = await callMcpTool(token, 'export_file', {
      projectId: PROJECT,
      fileId: FILE,
    })
    expect(isError).toBe(true)
    expect((payload.error as { code: string }).code).toBe('permission_denied')
  })

  it('refuses a binary export and names the REST URL instead', async () => {
    // A docx file keeps its side-car bytes; the internal route serves them raw.
    await bucket.put('blob/docx', new TextEncoder().encode('PKbinary'))
    await seedUsfmFile({ format: 'docx', rawSource: null, r2Key: 'blob/docx' })
    const token = await credToken({
      credentialId: CRED_MAINTAINER,
      userId: 1,
      username: 'maint',
      projectId: PROJECT,
    })

    // REST serves the bytes...
    const rest = (await handleExternalExportRequest(exportReq(token), makeEnv()))!
    expect(rest.status).toBe(200)
    expect(rest.headers.get('X-Export-Mode')).toBe('raw-sidecar')

    // ...MCP cannot carry them, so it hands the caller back to REST rather than
    // returning a mangled body.
    const { payload, isError } = await callMcpTool(token, 'export_file', {
      projectId: PROJECT,
      fileId: FILE,
    })
    expect(isError).toBe(true)
    const err = payload.error as { code: string; message: string; restPath: string }
    expect(err.code).toBe('validation_failed')
    expect(err.restPath).toContain(`/files/${FILE}/export`)
    expect(err.message).toContain('REST')
  })

  it('refuses an export larger than the inline limit rather than truncating it', async () => {
    // One verse whose translation alone exceeds the inline ceiling.
    await seedUsfmFile()
    await tdb.pg.query(`UPDATE cells SET value = $1 WHERE side = 'target' AND target_lang = ''`, [
      'x'.repeat(MCP_EXPORT_MAX_BYTES + 1),
    ])
    const token = await credToken({
      credentialId: CRED_MAINTAINER,
      userId: 1,
      username: 'maint',
      projectId: PROJECT,
    })

    const { payload, isError } = await callMcpTool(token, 'export_file', {
      projectId: PROJECT,
      fileId: FILE,
    })
    expect(isError).toBe(true)
    const err = payload.error as { code: string; maxBytes: number; restPath: string }
    expect(err.code).toBe('validation_failed')
    expect(err.maxBytes).toBe(MCP_EXPORT_MAX_BYTES)
    expect(err.restPath).toContain('/export')
  })

  it('returns the curated source when asked for side=source (AQU-1454)', async () => {
    await seedCuratedSourceFile()
    const token = await credToken({
      credentialId: CRED_MAINTAINER,
      userId: 1,
      username: 'maint',
      projectId: PROJECT,
    })

    const { payload, isError } = await callMcpTool(token, 'export_file', {
      projectId: PROJECT,
      fileId: CURATED_FILE,
      side: 'source',
    })
    expect(isError).toBe(false)
    expect(payload.side).toBe('source')

    // Same bytes the REST route hands back for the same file and side.
    const rest = (await handleExternalExportRequest(
      exportReq(token, { side: 'source', fileId: CURATED_FILE }),
      makeEnv(),
    ))!
    expect(String(payload.content)).toBe(await rest.text())

    const content = String(payload.content)
    expect(content).toContain(EDITED_SOURCE_V3)
    expect(content).not.toContain('Now the earth was formless')
    expect(content).not.toContain('TRANSLATION')
    // The payload says plainly that this is not a deliverable translation.
    expect(String(payload.note)).toContain('CURATED SOURCE')
  })

  it('returns the target lane unchanged when side is omitted or target', async () => {
    await seedCuratedSourceFile()
    const token = await credToken({
      credentialId: CRED_MAINTAINER,
      userId: 1,
      username: 'maint',
      projectId: PROJECT,
    })

    const omitted = await callMcpTool(token, 'export_file', {
      projectId: PROJECT,
      fileId: CURATED_FILE,
    })
    const explicit = await callMcpTool(token, 'export_file', {
      projectId: PROJECT,
      fileId: CURATED_FILE,
      side: 'target',
    })
    expect(omitted.payload.side).toBe('target')
    expect(explicit.payload.content).toBe(omitted.payload.content)
    expect(String(omitted.payload.content)).toContain('TRANSLATION ONE')
    expect(String(omitted.payload.content)).not.toContain(EDITED_SOURCE_V3)
    expect(omitted.payload.note).toBeUndefined()
  })

  it('rejects a side it does not know rather than quietly exporting the target', async () => {
    await seedCuratedSourceFile()
    const token = await credToken({
      credentialId: CRED_MAINTAINER,
      userId: 1,
      username: 'maint',
      projectId: PROJECT,
    })

    for (const side of ['both', '', 7]) {
      const { payload, isError } = await callMcpTool(token, 'export_file', {
        projectId: PROJECT,
        fileId: CURATED_FILE,
        side,
      })
      expect(isError).toBe(true)
      const err = payload.error as { code: string; message: string }
      expect(err.code).toBe('validation_failed')
      expect(err.message).toContain('"source"')
      expect(err.message).toContain('"target"')
    }
  })

  it('validates its arguments', async () => {
    const token = await credToken({
      credentialId: CRED_MAINTAINER,
      userId: 1,
      username: 'maint',
      projectId: PROJECT,
    })
    const { payload, isError } = await callMcpTool(token, 'export_file', { projectId: PROJECT })
    expect(isError).toBe(true)
    expect((payload.error as { code: string }).code).toBe('validation_failed')
  })
})

// ── discoverability ──────────────────────────────────────────────────────────

describe('export is discoverable (the cold-start contract)', () => {
  it('publishes export_file in the MCP tool catalog', async () => {
    const tool = MCP_TOOLS.find((t) => t.name === 'export_file')
    expect(tool).toBeDefined()
    expect(tool?.inputSchema.required).toEqual(['projectId', 'fileId'])
    // AQU-1454: an agent can only ask for the source side if the schema it
    // reads says the parameter exists and which values it takes.
    const sideProp = (tool?.inputSchema.properties as Record<string, { enum?: string[] }>).side
    expect(sideProp?.enum).toEqual(['source', 'target'])
    expect(tool?.description).toContain('side')
    expect(tool?.description).toContain('default "target"')

    const token = await credToken({
      credentialId: CRED_MAINTAINER,
      userId: 1,
      username: 'maint',
      projectId: PROJECT,
    })
    const res = (await handleExternalMcpRequest(
      new Request('https://w/api/v1/external/mcp', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
      makeEnv(),
    ))!
    const body = (await res.json()) as { result: { tools: { name: string }[] } }
    expect(body.result.tools.map((t) => t.name)).toContain('export_file')
  })

  it('publishes the REST export endpoint in the discovery map', async () => {
    const res = handleExternalDiscoveryRequest(new Request('https://w/api/v1/external'))!
    const map = (await res.json()) as {
      endpoints: Record<string, string>
      exporting: {
        restEndpoint?: string
        workflow: string[]
        side: { param: string; values: string[]; default: string }
      }
    }
    expect(
      Object.keys(map.endpoints).some((k) => k.includes('/files/:fileId/export')),
    ).toBe(true)
    expect(map.exporting.workflow.join(' ')).toContain('/export')
    // AQU-1454: the discovery document names the parameter, both values, and
    // which one an omitted side means.
    expect(map.exporting.side.param).toBe('side')
    expect(map.exporting.side.values).toEqual(['source', 'target'])
    expect(map.exporting.side.default).toBe('target')
    expect(map.exporting.workflow.join(' ')).toContain('side=source')
  })

  it('advertises export in get_capabilities with its role floor', async () => {
    const token = await credToken({
      credentialId: CRED_MAINTAINER,
      userId: 1,
      username: 'maint',
      projectId: PROJECT,
    })
    const { payload } = await callMcpTool(token, 'get_capabilities', {})
    const exporting = payload.exporting as {
      mcpTool: string
      minRoleLevel: number
      maxInlineBytes: number
      restEndpoint: string
      sides: { values: string[]; default: string }
    }
    expect(exporting.mcpTool).toBe('export_file')
    expect(exporting.minRoleLevel).toBe(600)
    expect(exporting.maxInlineBytes).toBe(MCP_EXPORT_MAX_BYTES)
    // AQU-1454: get_capabilities is the cold-start read, so the side parameter
    // has to be visible there too, not only on the tool schema.
    expect(exporting.sides.values).toEqual(['source', 'target'])
    expect(exporting.sides.default).toBe('target')
    expect(exporting.restEndpoint).toContain('side=')
  })
})
