// Tests for the server-side artifact parse route + MCP import tools
// (preview_import / prepare_import — AQU-533 §5 ingestion workflow).
//
// Covers the REAL composition, not mocks of it: a small USFM fixture and a
// bilingual CSV fixture are uploaded through the artifact route as raw bytes,
// previewed via POST .../artifacts/:id/parse, staged with { stage: true }, and
// the staged changeset's PlanImport command is asserted (cells + artifactId);
// the USFM plan is then committed and the file/cell projection checked.
// Also: unsupported (docx) → structured error naming the client alternative;
// >5000 parsed cells → validation_failed at staging; fileType override;
// multi-book USFM staging discipline; the MCP tool adapters; and a drift guard
// keeping the (literal) discovery-map format list equal to the parser core's.

import { describe, it, expect, beforeEach, vi } from 'vitest'

// commit.ts → events/route.ts → broadcast.ts → partyserver (cloudflare:*).
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalArtifactsRequest } from '../external/artifacts-route'
import { handleExternalChangesetsRequest } from '../external/changesets-route'
import { handleExternalDiscoveryRequest } from '../external/discovery-route'
import { handleExternalMcpRequest } from '../external/mcp-route'
import {
  SERVER_PARSEABLE_FILE_TYPES,
  BINARY_PARSE_FILE_TYPES,
  PREVIEW_SAMPLE_CELLS,
} from '../external/import-parse'
import {
  DOCX_PARITY_EXPECTED_CELLS,
  DOCX_PARITY_FILE_NAME,
  buildDocxParityFixture,
} from '../../../src/lib/parsers/__fixtures__/docx-parity'
import { PLAN_IMPORT_MAX_CELLS, type PlanImportCommand } from '../external/commands'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const PROJECT = 'proj-a'
const CRED_LEAD = '00000000-0000-0000-0000-0000000000b1'
const CRED_CONTRIB = '00000000-0000-0000-0000-0000000000b2'
const SECRET = 'test-secret'

// ── R2 stub (same shape as external-import.test.ts) ──────────────────────────

interface StoredObject {
  key: string
  body: ArrayBuffer
  httpMetadata?: { contentType?: string }
}

function makeStubBucket() {
  const store = new Map<string, StoredObject>()
  return {
    async get(key: string, options?: { range?: { offset: number; length: number } }) {
      const obj = store.get(key)
      if (!obj) return null
      const body = options?.range
        ? obj.body.slice(options.range.offset, options.range.offset + options.range.length)
        : obj.body
      return { arrayBuffer: async () => body, httpMetadata: obj.httpMetadata }
    },
    async put(
      key: string,
      value: ArrayBuffer | Uint8Array | string,
      opts?: { httpMetadata?: { contentType?: string } },
    ) {
      const body =
        typeof value === 'string'
          ? new TextEncoder().encode(value).buffer
          : value instanceof Uint8Array
            ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
            : value
      store.set(key, { key, body: body as ArrayBuffer, httpMetadata: opts?.httpMetadata })
    },
    async delete(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys]
      for (const k of list) store.delete(k)
    },
  }
}

function makeEnv(db: AquillaDb, bucket: ReturnType<typeof makeStubBucket>) {
  return {
    AQUILLA_PG: db,
    SYNC_SECRET_KEY: SECRET,
    BASE_URL: 'https://aquilla.app',
    SNAPSHOTS: bucket as unknown as R2Bucket,
  }
}

async function credToken(
  tdb: TestDb,
  spec: { credentialId: string; userId: number; username: string; mode?: 'ask' | 'act' },
): Promise<string> {
  await tdb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, 'h')
     ON CONFLICT (id) DO NOTHING`,
    [spec.userId, spec.username, `${spec.username}@x.com`],
  )
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  await tdb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id)
     VALUES ($1, $2, 'test', $3, $4, $5, NULL, $6)`,
    [spec.credentialId, String(spec.userId), tokenPrefix, tokenHash, spec.mode ?? 'act', PROJECT],
  )
  return token
}

async function seedProject(): Promise<TestDb> {
  return makeTestDb({
    projects: [{ id: PROJECT, name: 'P', created_by: 99, org_id: null }],
    project_members: [
      { project_id: PROJECT, user_id: 1, role_level: 500 }, // lead
      { project_id: PROJECT, user_id: 2, role_level: 400 }, // contributor
    ],
  })
}

// ── request helpers ──────────────────────────────────────────────────────────

async function upload(
  env: ReturnType<typeof makeEnv>,
  token: string,
  name: string,
  content: string,
  contentType?: string,
): Promise<string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'x-artifact-name': name,
  }
  if (contentType) headers['content-type'] = contentType
  const res = (await handleExternalArtifactsRequest(
    new Request(`https://w/api/v1/external/projects/${PROJECT}/artifacts`, {
      method: 'POST',
      headers,
      body: new TextEncoder().encode(content),
    }),
    env,
  ))!
  expect(res.status).toBe(200)
  return ((await res.json()) as { artifactId: string }).artifactId
}

/** Upload raw bytes (binary container formats can't round-trip through a string). */
async function uploadBytes(
  env: ReturnType<typeof makeEnv>,
  token: string,
  name: string,
  content: Uint8Array,
  contentType?: string,
): Promise<string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'x-artifact-name': name,
  }
  if (contentType) headers['content-type'] = contentType
  const res = (await handleExternalArtifactsRequest(
    new Request(`https://w/api/v1/external/projects/${PROJECT}/artifacts`, {
      method: 'POST',
      headers,
      body: content.slice().buffer as ArrayBuffer,
    }),
    env,
  ))!
  expect(res.status).toBe(200)
  return ((await res.json()) as { artifactId: string }).artifactId
}

function parseReq(token: string, artifactId: string, body?: Record<string, unknown>): Request {
  return new Request(
    `https://w/api/v1/external/projects/${PROJECT}/artifacts/${artifactId}/parse`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  )
}

function commitReq(token: string, id: string): Request {
  return new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets/${id}/commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
}

// ── fixtures ─────────────────────────────────────────────────────────────────

const USFM_GENESIS = [
  '\\id GEN Test Bible',
  '\\h Genesis',
  '\\c 1',
  '\\p',
  '\\v 1 In the beginning God created the heavens and the earth.',
  '\\v 2 And the earth was without form, and void.',
  '\\c 2',
  '\\p',
  '\\v 1 Thus the heavens and the earth were finished.',
].join('\n')

const CSV_BILINGUAL = [
  'source,target',
  'Hello,Bonjour',
  'Goodbye,Au revoir',
  '"One, two",«Un, deux»',
].join('\n')

/** Minimal ZIP local-file-header inventory (no inflation needed) — the same
 *  trick external-import.test.ts uses to fabricate container formats. */
function fakeZip(names: string[]): string {
  // Build via bytes then decode latin1-ish through TextDecoder is lossy; the
  // upload helper encodes utf-8, so restrict member names to ASCII and place
  // raw PK headers directly in the string (all bytes < 0x80 survive utf-8).
  let out = ''
  for (const name of names) {
    out += 'PK' + ' '.repeat(22)
    out += String.fromCharCode(name.length & 0xff) + String.fromCharCode(name.length >> 8)
    out += '  '
    out += name
  }
  return out
}

interface PreviewBody {
  fileName: string
  fileType: string
  detectedFormat?: string
  totalCells: number
  sampleCells: Array<Record<string, unknown>>
  warnings: Array<{ code: string; message: string }>
  results: Array<{ index: number; name: string; totalCells: number }>
}

interface StageBody {
  changeset: { id: string; status: string; autonomyMode: string }
  summary: Record<string, unknown>
  digest: string
  approvalUrl: string
  parse: { fileName: string; fileType: string; totalCells: number }
}

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> }
}

let tdb: TestDb
let bucket: ReturnType<typeof makeStubBucket>
let env: ReturnType<typeof makeEnv>
let leadToken: string

beforeEach(async () => {
  tdb = await seedProject()
  bucket = makeStubBucket()
  env = makeEnv(tdb.db, bucket)
  leadToken = await credToken(tdb, { credentialId: CRED_LEAD, userId: 1, username: 'lead' })
})

// ── REST: preview ────────────────────────────────────────────────────────────

describe('artifact parse — preview (REST)', () => {
  it('detects and parses a USFM artifact without staging anything', async () => {
    const artifactId = await upload(env, leadToken, 'Genesis.usfm', USFM_GENESIS)
    const res = (await handleExternalArtifactsRequest(parseReq(leadToken, artifactId), env))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as PreviewBody

    expect(body.fileType).toBe('usfm')
    expect(body.detectedFormat).toBe('usfm')
    expect(body.fileName).toBe('Genesis.usfm')
    // 3 verses + \h front-matter heading.
    const verses = body.sampleCells.filter((c) => c.type === 'verse')
    expect(verses).toHaveLength(3)
    expect(verses[0].canonicalRef).toBe('GEN 1:1')
    expect(verses[0].content).toBe('In the beginning God created the heavens and the earth.')
    expect(verses[2].canonicalRef).toBe('GEN 2:1')
    expect(body.totalCells).toBe(body.sampleCells.length) // small file: sample = all
    expect(body.totalCells).toBeLessThanOrEqual(PREVIEW_SAMPLE_CELLS)
    expect(body.results).toEqual([{ index: 0, name: 'Genesis.usfm', totalCells: body.totalCells }])

    // Nothing staged.
    expect(await tdb.rows('changesets')).toHaveLength(0)
    expect(await tdb.rows('files')).toHaveLength(0)
  })

  it('parses a bilingual CSV into cells with default-lane variants', async () => {
    const artifactId = await upload(env, leadToken, 'pairs.csv', CSV_BILINGUAL, 'text/csv')
    const res = (await handleExternalArtifactsRequest(parseReq(leadToken, artifactId), env))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as PreviewBody

    expect(body.fileType).toBe('csv')
    expect(body.totalCells).toBe(3)
    expect(body.sampleCells[0].content).toBe('Hello')
    expect(body.sampleCells[0].variants).toEqual([{ laneId: '', content: 'Bonjour' }])
    // RFC-4180 quoting survives the round trip.
    expect(body.sampleCells[2].content).toBe('One, two')
  })

  it('honors an explicit fileType override where sniffing would misclassify', async () => {
    // .properties content sniffs as plaintext (no commas/tabs/JSON markers).
    const artifactId = await upload(
      env,
      leadToken,
      'strings.properties',
      'greeting = Hello\nfarewell = Goodbye\n',
    )
    const detected = (await handleExternalArtifactsRequest(parseReq(leadToken, artifactId), env))!
    // Without the override the extension falls through as unsupported-or-txt —
    // either way the override must be what selects the .properties parser.
    void (await detected.json())

    const res = (await handleExternalArtifactsRequest(
      parseReq(leadToken, artifactId, { fileType: 'properties' }),
      env,
    ))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as PreviewBody
    expect(body.fileType).toBe('properties')
    expect(body.totalCells).toBe(2)
    expect(body.sampleCells.map((c) => c.content)).toEqual(['Hello', 'Goodbye'])
  })

  // AQU-1237: docx moved from clientOnly to server-parseable. The archive is
  // read by the SAME extractDocxStrings the in-app Import dialog runs, so these
  // assertions are the server half of the browser/server parity fixture in
  // src/lib/parsers/docx-parity.test.ts.
  it('parses a real .docx into the shared parity fixture cells', async () => {
    const artifactId = await uploadBytes(
      env,
      leadToken,
      DOCX_PARITY_FILE_NAME,
      buildDocxParityFixture(),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    const res = (await handleExternalArtifactsRequest(parseReq(leadToken, artifactId), env))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as PreviewBody
    expect(body.fileType).toBe('docx')
    expect(body.detectedFormat).toBe('docx')
    expect(body.fileName).toBe(DOCX_PARITY_FILE_NAME)
    expect(body.totalCells).toBe(DOCX_PARITY_EXPECTED_CELLS.length)
    // `context` (the Word paragraph style) is deliberately absent: PlanImportCell
    // has no such field, so NO server-parsed format carries it — a pre-existing
    // gap in the changeset command contract, not a docx one. The structural
    // signal that gap would lose (heading vs text) survives as `type`.
    expect(
      body.sampleCells.map((cell) => ({
        content: cell.content,
        type: cell.type,
        ...(cell.contentHtml !== undefined ? { contentHtml: cell.contentHtml } : {}),
        paragraphStart: cell.paragraphStart === true,
      })),
    ).toEqual(
      DOCX_PARITY_EXPECTED_CELLS.map((cell) => ({
        content: cell.original,
        type: cell.type,
        ...(cell.originalHtml !== undefined ? { contentHtml: cell.originalHtml } : {}),
        paragraphStart: cell.paragraphStart,
      })),
    )
  })

  it('accepts an explicit docx fileType (and the "word" alias)', async () => {
    const artifactId = await uploadBytes(
      env,
      leadToken,
      'no-extension',
      buildDocxParityFixture(),
    )
    for (const fileType of ['docx', 'word']) {
      const res = (await handleExternalArtifactsRequest(
        parseReq(leadToken, artifactId, { fileType }),
        env,
      ))!
      expect(res.status).toBe(200)
      const body = (await res.json()) as PreviewBody
      expect(body.fileType).toBe('docx')
      expect(body.totalCells).toBe(DOCX_PARITY_EXPECTED_CELLS.length)
    }
  })

  it('fails a malformed .docx with a named error at preview, never a partial parse', async () => {
    // Sniffs as docx (the member names are there) but has no readable central
    // directory — a truncated upload must be a named failure, not 0 cells.
    const artifactId = await upload(
      env,
      leadToken,
      'report.docx',
      fakeZip(['[Content_Types].xml', 'word/document.xml']),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    const res = (await handleExternalArtifactsRequest(parseReq(leadToken, artifactId), env))!
    expect(res.status).toBe(400)
    const body = (await res.json()) as ErrorBody
    expect(body.error.code).toBe('validation_failed')
    expect(body.error.message).toContain('docx')
    expect(body.error.details?.fileType).toBe('docx')
    expect(body.error.details?.detectedFormat).toBe('docx')
  })

  it('still rejects a DOM-bound format (pptx) with a structured error naming the client alternative', async () => {
    const artifactId = await upload(
      env,
      leadToken,
      'deck2.pptx',
      fakeZip(['ppt/slides/slide1.xml']),
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    )
    const res = (await handleExternalArtifactsRequest(parseReq(leadToken, artifactId), env))!
    expect(res.status).toBe(400)
    const body = (await res.json()) as ErrorBody
    expect(body.error.code).toBe('validation_failed')
    expect(body.error.message).toContain('pptx')
    expect(body.error.message).toContain('Import dialog')
    expect(body.error.details?.supportedFileTypes).toEqual(SERVER_PARSEABLE_FILE_TYPES)
    expect(body.error.details?.detectedFormat).toBe('pptx')
  })

  it('rejects an unknown explicit fileType, listing the supported set', async () => {
    const artifactId = await upload(env, leadToken, 'a.usfm', USFM_GENESIS)
    const res = (await handleExternalArtifactsRequest(
      parseReq(leadToken, artifactId, { fileType: 'idml' }),
      env,
    ))!
    expect(res.status).toBe(400)
    const body = (await res.json()) as ErrorBody
    expect(body.error.code).toBe('validation_failed')
    expect(body.error.details?.supportedFileTypes).toEqual(SERVER_PARSEABLE_FILE_TYPES)
  })
})

// ── REST: stage + commit (the real composition) ──────────────────────────────

describe('artifact parse — stage (REST)', () => {
  it('stages a PlanImport changeset with the parsed cells + artifactId, then commits to real projection', async () => {
    const artifactId = await upload(env, leadToken, 'Genesis.usfm', USFM_GENESIS)
    const res = (await handleExternalArtifactsRequest(
      parseReq(leadToken, artifactId, { stage: true, sourceLanguage: 'en' }),
      env,
    ))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as StageBody

    expect(body.changeset.status).toBe('staged')
    expect(body.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(body.approvalUrl).toBe(`https://aquilla.app/approve/${body.changeset.id}`)
    expect(body.summary.artifactLinked).toBe(artifactId)
    expect(body.parse.fileType).toBe('usfm')

    // The stored plan holds ONE PlanImport command with the parsed cells and
    // the artifact link — parsed server-side, not caller-supplied.
    const stored = await tdb.rows<{ id: string; commands: unknown }>('changesets')
    expect(stored).toHaveLength(1)
    const commands = (
      typeof stored[0].commands === 'string' ? JSON.parse(stored[0].commands) : stored[0].commands
    ) as PlanImportCommand[]
    expect(commands).toHaveLength(1)
    expect(commands[0].kind).toBe('PlanImport')
    expect(commands[0].artifactId).toBe(artifactId)
    expect(commands[0].fileName).toBe('Genesis.usfm')
    expect(commands[0].sourceLanguage).toBe('en')
    const verseCells = commands[0].cells.filter((c) => c.type === 'verse')
    expect(verseCells).toHaveLength(3)
    expect(verseCells.map((c) => c.canonicalRef)).toEqual(['GEN 1:1', 'GEN 1:2', 'GEN 2:1'])

    // Commit through the normal changeset pipeline: file + source cells land,
    // and the artifact is bound to the created file.
    const commit = (await handleExternalChangesetsRequest(commitReq(leadToken, body.changeset.id), env))!
    expect(commit.status).toBe(200)
    const receipt = ((await commit.json()) as { receipt: { fileId: string } }).receipt

    const files = await tdb.rows<{ id: string; name: string }>('files')
    expect(files.find((f) => f.id === receipt.fileId)?.name).toBe('Genesis.usfm')
    const cells = await tdb.rows<{ side: string; value: string; file_id: string }>('cells')
    const source = cells.filter((c) => c.side === 'source' && c.file_id === receipt.fileId)
    expect(source.map((c) => c.value)).toContain(
      'In the beginning God created the heavens and the earth.',
    )
    const artifacts = await tdb.rows<{ id: string; file_id: string | null }>('artifacts')
    expect(artifacts[0].file_id).toBe(receipt.fileId)
  })

  it('stages and commits a .docx, landing the same cells the browser import produces', async () => {
    // AQU-1237 acceptance: an agent uploads the file, previews it, then
    // import_file lands cells identical to a browser import of the same file.
    // The preview half is asserted against the shared fixture above; this is
    // the commit half, all the way through to the real projection.
    const artifactId = await uploadBytes(
      env,
      leadToken,
      DOCX_PARITY_FILE_NAME,
      buildDocxParityFixture(),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    const res = (await handleExternalArtifactsRequest(
      parseReq(leadToken, artifactId, { stage: true, sourceLanguage: 'en' }),
      env,
    ))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as StageBody
    expect(body.parse.fileType).toBe('docx')
    expect(body.summary.artifactLinked).toBe(artifactId)

    const stored = await tdb.rows<{ commands: unknown }>('changesets')
    const commands = (
      typeof stored[0].commands === 'string' ? JSON.parse(stored[0].commands) : stored[0].commands
    ) as PlanImportCommand[]
    expect(commands[0].fileType).toBe('docx')
    expect(commands[0].artifactId).toBe(artifactId)
    expect(commands[0].cells.map((c) => c.content)).toEqual(
      DOCX_PARITY_EXPECTED_CELLS.map((c) => c.original),
    )
    // Heading paragraphs keep their structural type; run formatting survives
    // as contentHtml — the two things a lossy text-only extractor would drop.
    expect(commands[0].cells.filter((c) => c.type === 'heading')).toHaveLength(2)
    expect(commands[0].cells[2].contentHtml).toBe(
      'Plain sentence with an <b>emphasised</b> word & an entity.',
    )

    const commit = (await handleExternalChangesetsRequest(commitReq(leadToken, body.changeset.id), env))!
    expect(commit.status).toBe(200)
    const receipt = ((await commit.json()) as { receipt: { fileId: string } }).receipt
    const files = await tdb.rows<{ id: string; name: string }>('files')
    expect(files.find((f) => f.id === receipt.fileId)?.name).toBe(DOCX_PARITY_FILE_NAME)
    const cells = await tdb.rows<{ side: string; value: string; file_id: string }>('cells')
    expect(
      cells.filter((c) => c.side === 'source' && c.file_id === receipt.fileId).map((c) => c.value),
    ).toEqual(DOCX_PARITY_EXPECTED_CELLS.map((c) => c.original))
  })

  it('stages a bilingual CSV whose PlanImport cells carry default-lane variants', async () => {
    const artifactId = await upload(env, leadToken, 'pairs.csv', CSV_BILINGUAL, 'text/csv')
    const res = (await handleExternalArtifactsRequest(
      parseReq(leadToken, artifactId, { stage: true }),
      env,
    ))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as StageBody
    expect(body.summary.sourceCellsAdded).toBe(3)
    expect(body.summary.targetVariantsAdded).toBe(3)

    const stored = await tdb.rows<{ commands: unknown }>('changesets')
    const commands = (
      typeof stored[0].commands === 'string' ? JSON.parse(stored[0].commands) : stored[0].commands
    ) as PlanImportCommand[]
    expect(commands[0].artifactId).toBe(artifactId)
    expect(commands[0].cells[1]).toMatchObject({
      content: 'Goodbye',
      variants: [{ laneId: '', content: 'Au revoir' }],
    })
  })

  it('rejects staging past the PlanImport cell cap with validation_failed', async () => {
    // 5001 plaintext paragraphs → 5001 cells (each short line is one segment).
    const big = Array.from({ length: PLAN_IMPORT_MAX_CELLS + 1 }, (_, i) => `Paragraph ${i}.`).join('\n\n')
    const artifactId = await upload(env, leadToken, 'big.txt', big)

    // Preview surfaces the overflow as a warning instead of failing.
    const preview = (await handleExternalArtifactsRequest(parseReq(leadToken, artifactId), env))!
    expect(preview.status).toBe(200)
    const previewBody = (await preview.json()) as PreviewBody
    expect(previewBody.totalCells).toBe(PLAN_IMPORT_MAX_CELLS + 1)
    expect(previewBody.warnings.some((w) => w.code === 'over-cell-cap')).toBe(true)

    // Staging fails loudly through the shared prepare pipeline.
    const res = (await handleExternalArtifactsRequest(
      parseReq(leadToken, artifactId, { stage: true }),
      env,
    ))!
    expect(res.status).toBe(400)
    const body = (await res.json()) as ErrorBody
    expect(body.error.code).toBe('validation_failed')
    expect(body.error.details?.maxCells).toBe(PLAN_IMPORT_MAX_CELLS)
    expect(await tdb.rows('changesets')).toHaveLength(0)
  })

  it('requires resultIndex to stage a multi-book USFM artifact and names each book', async () => {
    const twoBooks = `${USFM_GENESIS}\n\\id EXO Test Bible\n\\c 1\n\\p\n\\v 1 Now these are the names.`
    const artifactId = await upload(env, leadToken, 'ot.usfm', twoBooks)

    const noIndex = (await handleExternalArtifactsRequest(
      parseReq(leadToken, artifactId, { stage: true }),
      env,
    ))!
    expect(noIndex.status).toBe(400)
    const err = (await noIndex.json()) as ErrorBody
    expect(err.error.code).toBe('validation_failed')
    expect(err.error.details?.results).toEqual([
      { index: 0, name: 'GEN', totalCells: expect.any(Number) },
      { index: 1, name: 'EXO', totalCells: expect.any(Number) },
    ])

    const staged = (await handleExternalArtifactsRequest(
      parseReq(leadToken, artifactId, { stage: true, resultIndex: 1 }),
      env,
    ))!
    expect(staged.status).toBe(200)
    const body = (await staged.json()) as StageBody
    expect(body.parse.fileName).toBe('EXO')
    expect(body.parse.totalCells).toBe(1)
  })

  it('enforces the PlanImport role floor at staging (contributor → permission_denied)', async () => {
    const contribToken = await credToken(tdb, {
      credentialId: CRED_CONTRIB,
      userId: 2,
      username: 'contrib',
    })
    const artifactId = await upload(env, contribToken, 'Genesis.usfm', USFM_GENESIS)

    // Contributor can preview…
    const preview = (await handleExternalArtifactsRequest(parseReq(contribToken, artifactId), env))!
    expect(preview.status).toBe(200)

    // …but staging hits handlePrepare's PlanImport floor (PROJECT_LEAD).
    const res = (await handleExternalArtifactsRequest(
      parseReq(contribToken, artifactId, { stage: true }),
      env,
    ))!
    expect(res.status).toBe(403)
    expect(((await res.json()) as ErrorBody).error.code).toBe('permission_denied')
    expect(await tdb.rows('changesets')).toHaveLength(0)
  })

  it('respects the ask-mode autonomy ceiling exactly like REST PlanImport', async () => {
    const askToken = await credToken(tdb, {
      credentialId: CRED_CONTRIB,
      userId: 1,
      username: 'lead',
      mode: 'ask',
    })
    const artifactId = await upload(env, askToken, 'Genesis.usfm', USFM_GENESIS)
    const res = (await handleExternalArtifactsRequest(
      parseReq(askToken, artifactId, { stage: true }),
      env,
    ))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as StageBody
    expect(body.changeset.autonomyMode).toBe('ask')

    // Ask-mode commit without approval → confirmation_required, nothing applied.
    const commit = (await handleExternalChangesetsRequest(commitReq(askToken, body.changeset.id), env))!
    expect(commit.status).toBe(428)
    expect(await tdb.rows('files')).toHaveLength(0)
  })
})

// ── REST: USFM content-only + front-matter parity (AQU-1283) ─────────────────

/** Mirrors the Acts import that surfaced AQU-1283: intro block, running
 *  header + title, an in-body section heading, a verse with footnote / \add /
 *  nested \+bk / mid-verse \p carrying a USFM `~`, and a dangling trailing \p. */
const USFM_ACTS = [
  '\\id ACT Test Bible',
  '\\h Деяния',
  '\\toc1 Деяния апостолов',
  '\\mt1 Деяния апостолов',
  '\\imt Введение',
  '\\ip Эта книга написана Лукой.',
  '\\io1 План книги \\ior 1:1–8:3\\ior*',
  '\\ili1 Первый пункт',
  '\\c 1',
  '\\s1 Обещание Святого Духа',
  '\\p',
  '\\v 4 Однажды, обедая вместе с ними\\f + \\fr 1:4 \\ft Или: «\\fqa Однажды, собрав их…\\ft »\\f*, Он велел \\add им\\add* не покидать \\+bk Иерусалим\\+bk*.',
  '\\p —~Это то, о чём говорил Отец.',
  '\\v 5 Иоанн крестил водой.',
  '\\p',
].join('\r\n')

const ACT_1_4_TEXT =
  'Однажды, обедая вместе с ними, Он велел им не покидать Иерусалим.\n— Это то, о чём говорил Отец.'

/** The cells the in-app importer (parseUsfmLossless, AQU-634) drops when the
 *  project opts out of front matter: identification + title + introduction.
 *  Section headings stay. The agent path must agree with the browser. (\ili
 *  is not a paratext kind the lossless parser emits as a cell in EITHER mode,
 *  so it is absent from this list on purpose.) */
const FRONT_MATTER_TEXTS = [
  'Деяния',
  'Деяния апостолов', // \toc1 and \mt1 both carry it → two cells
  'Введение',
  'Эта книга написана Лукой.',
  'План книги 1:1–8:3',
]
const FRONT_MATTER_CELL_COUNT = FRONT_MATTER_TEXTS.length + 1

interface UsfmCell {
  content: string
  type?: string
  canonicalRef?: string
  metadata?: { usfmNotes?: { kind: string; caller: string; ref: string; text: string; raw?: string }[] }
}

async function setImportExcludeFrontMatter(value: boolean) {
  await tdb.pg.query(
    `INSERT INTO project_settings (project_id, settings, version) VALUES ($1, $2, 1)
     ON CONFLICT (project_id) DO UPDATE SET settings = EXCLUDED.settings`,
    [PROJECT, JSON.stringify({ importExcludeFrontMatter: value })],
  )
}

async function stagedCells(): Promise<UsfmCell[]> {
  const stored = await tdb.rows<{ commands: unknown }>('changesets')
  expect(stored).toHaveLength(1)
  const commands = (
    typeof stored[0].commands === 'string' ? JSON.parse(stored[0].commands) : stored[0].commands
  ) as PlanImportCommand[]
  return commands[0].cells as UsfmCell[]
}

describe('artifact parse — USFM content-only fidelity (AQU-1283)', () => {
  it('preview cells carry no USFM markers: footnotes move to metadata.usfmNotes, ~ becomes a space, trailing \\p vanishes', async () => {
    const artifactId = await upload(env, leadToken, 'Acts.usfm', USFM_ACTS)
    const res = (await handleExternalArtifactsRequest(parseReq(leadToken, artifactId), env))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as PreviewBody & { excludeFrontMatter: unknown }
    const cells = body.sampleCells as unknown as UsfmCell[]
    expect(body.totalCells).toBe(cells.length)

    // WHY: the agent:usfm profile is content-only — agents draft from `value`
    // and never run the SPA's display transform.
    for (const cell of cells) expect(cell.content).not.toContain('\\')
    expect(body.warnings.some((w) => w.code === 'residual-markup')).toBe(false)

    const v4 = cells.find((c) => c.canonicalRef === 'ACT 1:4')!
    expect(v4.content).toBe(ACT_1_4_TEXT)
    // AQU-1295: `raw` rides along so export can put the note back exactly as
    // it arrived. This note is why it has to: `\fqa` is flattened out of
    // `text`, so a rebuild from the parsed fields would lose the sub-marker.
    expect(v4.metadata?.usfmNotes).toEqual([
      {
        kind: 'footnote',
        caller: '+',
        ref: '1:4',
        text: 'Или: « Однажды, собрав их… »',
        raw: '\\f + \\fr 1:4 \\ft Или: «\\fqa Однажды, собрав их…\\ft »\\f*',
      },
    ])
    const v5 = cells.find((c) => c.canonicalRef === 'ACT 1:5')!
    expect(v5.content).toBe('Иоанн крестил водой.')
    expect(v5.metadata).toBeUndefined()
    // \ior inside the intro outline unwraps like any character marker.
    expect(cells.map((c) => c.content)).toContain('План книги 1:1–8:3')
    expect(cells.map((c) => c.content)).toContain('Обещание Святого Духа')

    // No request override and no project setting → the default, and it says so.
    expect(body.excludeFrontMatter).toEqual({ value: false, source: 'default' })
  })

  it('commits exactly what the preview showed — marker-free values and the footnote side field', async () => {
    const artifactId = await upload(env, leadToken, 'Acts.usfm', USFM_ACTS)
    const preview = (await handleExternalArtifactsRequest(parseReq(leadToken, artifactId), env))!
    const previewBody = (await preview.json()) as PreviewBody

    const staged = (await handleExternalArtifactsRequest(
      parseReq(leadToken, artifactId, { stage: true }),
      env,
    ))!
    expect(staged.status).toBe(200)
    const stageBody = (await staged.json()) as StageBody & { parse: { excludeFrontMatter: unknown } }
    expect(stageBody.parse.totalCells).toBe(previewBody.totalCells)
    expect(stageBody.parse.excludeFrontMatter).toEqual({ value: false, source: 'default' })
    for (const cell of await stagedCells()) expect(cell.content).not.toContain('\\')

    const commit = (await handleExternalChangesetsRequest(commitReq(leadToken, stageBody.changeset.id), env))!
    expect(commit.status).toBe(200)
    const receipt = ((await commit.json()) as { receipt: { fileId: string } }).receipt
    const rows = await tdb.rows<{ side: string; value: string; file_id: string; metadata: unknown }>('cells')
    const source = rows.filter((c) => c.side === 'source' && c.file_id === receipt.fileId)
    expect(source).toHaveLength(previewBody.totalCells)
    for (const row of source) expect(row.value).not.toContain('\\')
    const v4 = source.find((c) => c.value === ACT_1_4_TEXT)!
    const meta = (typeof v4.metadata === 'string' ? JSON.parse(v4.metadata) : v4.metadata) as UsfmCell['metadata']
    expect(meta?.usfmNotes?.[0].text).toBe('Или: « Однажды, собрав их… »')
  })

  it('honours the project importExcludeFrontMatter setting in preview AND commit, like the in-app importer', async () => {
    await setImportExcludeFrontMatter(true)
    const artifactId = await upload(env, leadToken, 'Acts.usfm', USFM_ACTS)

    const preview = (await handleExternalArtifactsRequest(parseReq(leadToken, artifactId), env))!
    expect(preview.status).toBe(200)
    const previewBody = (await preview.json()) as PreviewBody & { excludeFrontMatter: unknown }
    expect(previewBody.excludeFrontMatter).toEqual({ value: true, source: 'project-setting' })
    const previewTexts = previewBody.sampleCells.map((c) => c.content)
    for (const text of FRONT_MATTER_TEXTS) expect(previewTexts).not.toContain(text)
    expect(previewTexts).toContain('Обещание Святого Духа')
    expect(previewTexts).toContain(ACT_1_4_TEXT)
    expect(previewBody.totalCells).toBe(3) // \s1 + 2 verses

    const staged = (await handleExternalArtifactsRequest(
      parseReq(leadToken, artifactId, { stage: true }),
      env,
    ))!
    expect(staged.status).toBe(200)
    const stageBody = (await staged.json()) as StageBody & { parse: { excludeFrontMatter: unknown } }
    expect(stageBody.parse.excludeFrontMatter).toEqual({ value: true, source: 'project-setting' })
    expect(stageBody.parse.totalCells).toBe(3)

    const commit = (await handleExternalChangesetsRequest(commitReq(leadToken, stageBody.changeset.id), env))!
    expect(commit.status).toBe(200)
    const receipt = ((await commit.json()) as { receipt: { fileId: string } }).receipt
    const rows = await tdb.rows<{ side: string; value: string; file_id: string }>('cells')
    const values = rows.filter((c) => c.side === 'source' && c.file_id === receipt.fileId).map((c) => c.value)
    expect(values).toHaveLength(3)
    for (const text of FRONT_MATTER_TEXTS) expect(values).not.toContain(text)
    expect(values).toContain('Обещание Святого Духа')
  })

  it('an explicit excludeFrontMatter in the request overrides the project setting', async () => {
    await setImportExcludeFrontMatter(true)
    const artifactId = await upload(env, leadToken, 'Acts.usfm', USFM_ACTS)
    const res = (await handleExternalArtifactsRequest(
      parseReq(leadToken, artifactId, { excludeFrontMatter: false }),
      env,
    ))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as PreviewBody & { excludeFrontMatter: unknown }
    expect(body.excludeFrontMatter).toEqual({ value: false, source: 'request' })
    const texts = body.sampleCells.map((c) => c.content)
    for (const text of FRONT_MATTER_TEXTS) expect(texts).toContain(text)
    expect(body.totalCells).toBe(3 + FRONT_MATTER_CELL_COUNT)
  })
})

// ── MCP: preview_import / prepare_import ─────────────────────────────────────

async function callMcpTool(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ payload: Record<string, unknown>; isError: boolean }> {
  const res = (await handleExternalMcpRequest(
    new Request('https://w/api/v1/external/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }),
    env,
  ))!
  const body = (await res.json()) as {
    result: { content: { text: string }[]; isError?: boolean }
  }
  return {
    payload: JSON.parse(body.result.content[0].text) as Record<string, unknown>,
    isError: body.result.isError === true,
  }
}

describe('MCP preview_import / prepare_import', () => {
  it('preview_import returns the parse without staging; prepare_import stages and points at confirm_changeset', async () => {
    const artifactId = await upload(env, leadToken, 'Genesis.usfm', USFM_GENESIS)

    const preview = await callMcpTool(leadToken, 'preview_import', { projectId: PROJECT, artifactId })
    expect(preview.isError).toBe(false)
    expect(preview.payload.fileType).toBe('usfm')
    expect(preview.payload.totalCells).toBeGreaterThanOrEqual(3)
    expect(await tdb.rows('changesets')).toHaveLength(0)

    const prepared = await callMcpTool(leadToken, 'prepare_import', {
      projectId: PROJECT,
      artifactId,
      fileName: 'Genesis (imported).usfm',
    })
    expect(prepared.isError).toBe(false)
    expect(typeof prepared.payload.changesetId).toBe('string')
    expect(typeof prepared.payload.digest).toBe('string')
    expect(prepared.payload.mode).toBe('act')
    expect(String(prepared.payload.nextStep)).toContain('confirm_changeset')
    expect((prepared.payload.parse as { fileName: string }).fileName).toBe('Genesis (imported).usfm')

    const stored = await tdb.rows<{ commands: unknown }>('changesets')
    expect(stored).toHaveLength(1)
    const commands = (
      typeof stored[0].commands === 'string' ? JSON.parse(stored[0].commands) : stored[0].commands
    ) as PlanImportCommand[]
    expect(commands[0].kind).toBe('PlanImport')
    expect(commands[0].artifactId).toBe(artifactId)
    expect(commands[0].fileName).toBe('Genesis (imported).usfm')
  })

  it('surfaces the unsupported-format error verbatim through the MCP adapter', async () => {
    const artifactId = await upload(env, leadToken, 'deck.pptx', fakeZip(['ppt/slides/slide1.xml']))
    const result = await callMcpTool(leadToken, 'preview_import', { projectId: PROJECT, artifactId })
    expect(result.isError).toBe(true)
    const err = result.payload.error as { code: string; message: string }
    expect(err.code).toBe('validation_failed')
    expect(err.message).toContain('pptx')
  })
})

// ── discovery drift guard ────────────────────────────────────────────────────

describe('discovery importing section', () => {
  it('publishes the SAME server-parseable format list the parse route enforces', async () => {
    const res = handleExternalDiscoveryRequest(
      new Request('https://w/api/v1/external', { method: 'GET' }),
    )!
    const map = (await res.json()) as {
      importing: { serverParseableFormats: string[]; limits: { maxArtifactBytes: number; planImportMaxCells: number } }
      endpoints: Record<string, string>
    }
    // The discovery map is a static literal (importing it from import-parse.ts
    // would create a module cycle through artifacts-route) — this test is the
    // drift guard keeping the published list equal to the enforced one.
    expect(map.importing.serverParseableFormats).toEqual(SERVER_PARSEABLE_FILE_TYPES)
    // AQU-1237: byte-oriented formats are dispatched by a switch in
    // import-parse.ts that must list every member of this set. Pinning the set
    // here forces whoever adds the next container format (usx/paratext, idml,
    // zip) to come back and confirm the dispatcher grew with it.
    expect([...BINARY_PARSE_FILE_TYPES]).toEqual(['docx'])
    expect(map.importing.limits.planImportMaxCells).toBe(PLAN_IMPORT_MAX_CELLS)
    expect(map.importing.limits.maxArtifactBytes).toBe(25 * 1024 * 1024)
    expect(
      Object.keys(map.endpoints).some((k) => k.includes('/artifacts/:artifactId/parse')),
    ).toBe(true)
  })
})
