// AQU-1566 (option b): a linked video's captions become the file's own rows.
// Modelled on import-track-publication.test.ts, against real Postgres (PGlite).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { promoteCaptionsToRows } from '../events/import-caption-promotion'
import { handleBulkImportRequest } from '../events/import-route'
import { handleRebuildProjectionRequest } from '../events/rebuild'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'

const SECRET = 'caption-promotion-secret'
const YOUTUBE = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
let store: TestDb
beforeAll(async () => { store = await makeTestDb() })
afterAll(async () => { await store?.close() })

const PARENT_META = {
  coreMediaUrl: YOUTUBE, orderedBy: 'time', timingMode: 'dubbing',
  importFormat: 'video', parserVersion: 'builtin:video@1',
  aquillaImport: { profileId: 'builtin:video', unitCount: 0 },
  sourceLanguage: 'en', targetLanguage: 'fr',
  trackOverrides: { other: {
    kind: 'source-subtitles', name: 'Other captions', contentFileId: 'other-cues',
  } },
}

beforeEach(async () => {
  await store.reset()
  // Track editing stays OFF throughout: promotion must not need it.
  await store.pg.query(`INSERT INTO project_settings (project_id, settings)
    VALUES ('p', '{}')`)
  await store.pg.query(`INSERT INTO files
    (id, project_id, name, role, kind, anchor_file_id, deleted_at, meta, event_id)
    VALUES ('video', 'p', 'Episode one', 'source', 'video', NULL, NULL, $1, 'video-create'),
      ('cues', 'p', 'captions.srt', 'timeline-content', 'srt', 'video', 1, $2, 'cues-create')`,
  [JSON.stringify(PARENT_META), JSON.stringify({
    orderedBy: 'time', importFormat: 'srt', parserVersion: 'builtin:srt@1',
    aquillaImport: { profileId: 'builtin:srt', unitCount: 3 },
  })])
  // Inserted out of time order: rows must come out in caption time order.
  await store.pg.query(`INSERT INTO cells
    (project_id, file_id, cell_id, side, value, value_html, type, start_ms, end_ms,
     sequence_index, metadata, event_id, last_edit_at)
    VALUES
      ('p','cues','cue-c','source','Third caption',NULL,'cue',4000,5000,2,
        '{"aquillaImport":{"physicalOrder":2}}','cue-c-create',1),
      ('p','cues','cue-a','source','First caption','<b>First</b> caption','cue',0,1000,0,
        '{"aquillaImport":{"physicalOrder":0},"speaker":"Ana"}','cue-a-create',1),
      ('p','cues','cue-b','source','Second caption',NULL,'cue',2000,3000,1,
        NULL,'cue-b-create',1)`)
  await store.pg.query(`INSERT INTO file_source_blobs
    (file_id, project_id, format, raw_source, r2_key, size_bytes, created_at)
    VALUES ('cues', 'p', 'srt', NULL, 'artifacts/p/a1/original.srt', 120, 1)`)
})

const newCaptions = () => ({
  projectId: 'p', fileId: 'video', author: 'maria', role: 600, clientTs: 5,
  promotion: { contentFileId: 'cues', genesisEventId: 'promote-genesis' },
})

const existingTrack = (trackId = 'episode') => ({
  ...newCaptions(),
  promotion: { contentFileId: 'cues', trackId, genesisEventId: 'promote-genesis',
    retireEventId: 'promote-retire', deleteEventId: 'promote-delete' },
})

async function attachAsTrack(trackId: string, override: Record<string, unknown>) {
  await store.pg.query(`UPDATE files SET deleted_at = NULL WHERE id = 'cues'`)
  await store.pg.query(`UPDATE files SET meta = jsonb_set(meta::jsonb,
    ARRAY['trackOverrides', $1], $2::jsonb)::text WHERE id = 'video'`,
  [trackId, JSON.stringify(override)])
}

async function file(id: string) {
  const result = await store.pg.query<Record<string, unknown>>(
    `SELECT id, kind, role, deleted_at, event_id, cell_count, meta::jsonb AS meta
       FROM files WHERE id = $1`, [id])
  return result.rows[0] as { kind: string; deleted_at: unknown; event_id: string
    cell_count: number; meta: Record<string, any> }
}

async function parentRows() {
  return (await store.pg.query<Record<string, any>>(
    `SELECT cell_id, value, value_html, type, start_ms, end_ms, sequence_index,
            anchor_cell_id, metadata, event_id
       FROM cells WHERE file_id = 'video' AND side = 'source'
      ORDER BY start_ms`)).rows
}

describe('caption rows promotion: new captions', () => {
  it('copies the staged cues into the linked video as its own rows', async () => {
    expect(await promoteCaptionsToRows(store.db, newCaptions()))
      .toEqual({ ok: true, cellCount: 3 })
    const rows = await parentRows()
    expect(rows.map(row => [row.value, Number(row.start_ms), Number(row.end_ms)])).toEqual([
      ['First caption', 0, 1000], ['Second caption', 2000, 3000], ['Third caption', 4000, 5000],
    ])
    expect(rows[0]).toMatchObject({ value_html: '<b>First</b> caption', type: 'cue',
      metadata: { aquillaImport: { physicalOrder: 0 }, speaker: 'Ana' } })
    expect(rows[1].metadata).toBeNull()
    // Fresh ids, chained in time order: no cue id ever lives in two files.
    expect(rows.map(row => row.cell_id)).not.toContain('cue-a')
    expect(new Set(rows.map(row => row.cell_id)).size).toBe(3)
    expect(rows.map(row => row.anchor_cell_id))
      .toEqual([null, rows[0].cell_id, rows[1].cell_id])
    expect(rows.map(row => Number(row.sequence_index))).toEqual([0, 1, 2])
  })

  it('re-kinds the file to the caption format and keeps its video and tracks', async () => {
    await promoteCaptionsToRows(store.db, newCaptions())
    const parent = await file('video')
    expect(parent.kind).toBe('srt')
    expect(parent.event_id).toBe('promote-genesis')
    expect(parent.cell_count).toBe(3)
    expect(parent.meta).toEqual({
      ...PARENT_META, importFormat: 'srt', parserVersion: 'builtin:srt@1',
      aquillaImport: { profileId: 'builtin:srt', unitCount: 3 },
    })
    const progress = await store.pg.query<{ total_count: number }>(
      `SELECT total_count FROM file_section_progress
        WHERE file_id = 'video' AND scope = 'file'`)
    expect(progress.rows.map(row => row.total_count)).toEqual([3])
    const blobs = await store.rows<Record<string, unknown>>('file_source_blobs')
    expect(blobs.find(blob => blob.file_id === 'video')).toMatchObject({
      project_id: 'p', format: 'srt', r2_key: 'artifacts/p/a1/original.srt',
    })
    const events = await store.rows<Record<string, any>>('events')
    expect(events.map(event => event.kind).sort())
      .toEqual(['file.create', 'source.cell.create', 'source.cell.create', 'source.cell.create'])
    const genesis = events.find(event => event.id === 'promote-genesis')!
    expect(genesis).toMatchObject({ file_id: 'video', parent_id: 'video-create', author: 'maria' })
    expect(JSON.parse(genesis.payload)).toMatchObject({
      name: 'Episode one', fileType: 'srt', kind: 'srt', role: 'source',
      importFormat: 'srt', orderedBy: 'time', parserVersion: 'builtin:srt@1',
    })
    // The staged copy stays hidden and deleted; its cues are untouched.
    expect((await file('cues')).deleted_at).not.toBeNull()
    expect((await store.rows<Record<string, unknown>>('cells'))
      .filter(cell => cell.file_id === 'cues')).toHaveLength(3)
  })

  it('drops the zero-row link manifest when the content carries none', async () => {
    await store.pg.query(`UPDATE files SET meta = '{"orderedBy":"time"}' WHERE id = 'cues'`)
    expect(await promoteCaptionsToRows(store.db, newCaptions())).toMatchObject({ ok: true })
    const meta = (await file('video')).meta
    expect(meta).not.toHaveProperty('aquillaImport')
    expect(meta).not.toHaveProperty('parserVersion')
    expect(meta).toMatchObject({ coreMediaUrl: YOUTUBE, importFormat: 'srt' })
  })

  it('copies only a caption original', async () => {
    await store.pg.query(`UPDATE file_source_blobs SET format = 'txt' WHERE file_id = 'cues'`)
    expect(await promoteCaptionsToRows(store.db, newCaptions())).toMatchObject({ ok: true })
    expect((await store.rows<Record<string, unknown>>('file_source_blobs'))
      .map(blob => blob.file_id)).toEqual(['cues'])
  })

  it('answers a retried request from its receipt without writing again', async () => {
    expect(await promoteCaptionsToRows(store.db, newCaptions())).toMatchObject({ ok: true })
    const before = await parentRows()
    expect(await promoteCaptionsToRows(store.db, newCaptions()))
      .toEqual({ ok: true, cellCount: 3 })
    expect(await parentRows()).toEqual(before)
    expect(await store.rows('events')).toHaveLength(4)
    const pending = await store.pg.query(`SELECT * FROM seq_allocations`)
    expect(pending.rows).toHaveLength(0)
  })

  it('refuses a receipt id that belongs to another write', async () => {
    await store.pg.query(`INSERT INTO events
      (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author,
       payload, client_ts, server_ts, server_seq)
      VALUES ('promote-genesis', 1, 'p', 'video', NULL, NULL, 'file.rename', 'x',
       '{"name":"x"}', 1, 1, 1)`)
    expect(await promoteCaptionsToRows(store.db, newCaptions()))
      .toMatchObject({ ok: false, status: 409 })
    expect(await parentRows()).toHaveLength(0)
  })

  it('copies a large caption file in bounded statements', async () => {
    await store.pg.query(`DELETE FROM cells WHERE file_id = 'cues'`)
    await store.pg.query(`INSERT INTO cells
      (project_id, file_id, cell_id, side, value, type, start_ms, end_ms,
       sequence_index, event_id, last_edit_at)
      SELECT 'p', 'cues', 'cue-' || n, 'source', 'Caption ' || n, 'cue',
             n * 1100, n * 1100 + 1000, n, 'cue-create-' || n, 1
        FROM generate_series(0, 1599) AS n`)
    expect(await promoteCaptionsToRows(store.db, newCaptions()))
      .toEqual({ ok: true, cellCount: 1600 })
    expect((await file('video')).cell_count).toBe(1600)
    const rows = await parentRows()
    expect(rows.at(-1)).toMatchObject({ value: 'Caption 1599' })
    expect(rows.at(-1)!.anchor_cell_id).toBe(rows.at(-2)!.cell_id)
  })
})

describe('caption rows promotion: an existing timeline track', () => {
  it('turns the track into rows, retires it and deletes its file', async () => {
    await attachAsTrack('episode', {
      kind: 'source-subtitles', name: 'Episode captions', contentFileId: 'cues',
    })
    expect(await promoteCaptionsToRows(store.db, existingTrack()))
      .toEqual({ ok: true, cellCount: 3 })
    const parent = await file('video')
    expect(parent.kind).toBe('srt')
    expect(parent.meta.trackOverrides).toEqual(PARENT_META.trackOverrides)
    expect((await file('cues')).deleted_at).not.toBeNull()
    expect((await parentRows()).map(row => row.value))
      .toEqual(['First caption', 'Second caption', 'Third caption'])
    const kinds = (await store.rows<Record<string, any>>('events')).map(event => event.kind)
    expect(kinds.filter(kind => kind !== 'source.cell.create').sort())
      .toEqual(['file.create', 'file.delete', 'file.track.set'])
  })

  it('takes over the derived Source text row the old dialog let a track overwrite', async () => {
    await attachAsTrack('source-subtitles', { name: 'Captions', contentFileId: 'cues' })
    expect(await promoteCaptionsToRows(store.db, existingTrack('source-subtitles')))
      .toMatchObject({ ok: true })
    expect((await file('video')).meta.trackOverrides).not.toHaveProperty('source-subtitles')
  })

  // The old dialog could re-point the derived Source text or Target text row
  // at a hidden caption file. Left in place, that row kept drawing those
  // captions while the Text view showed the new rows.
  it('gives the derived text rows back to the new rows and keeps their captions as a track', async () => {
    await attachAsTrack('episode', {
      kind: 'source-subtitles', name: 'Episode captions', contentFileId: 'cues',
    })
    await store.pg.query(`UPDATE files SET meta = jsonb_set(meta::jsonb, '{trackOverrides}',
      (meta::jsonb -> 'trackOverrides') || $1::jsonb)::text WHERE id = 'video'`,
    [JSON.stringify({
      'source-subtitles': { name: 'Old source', contentFileId: 'old-source' },
      'target-subtitles': { name: 'Old target', contentFileId: 'old-target', color: 'amber' },
    })])
    expect(await promoteCaptionsToRows(store.db, existingTrack()))
      .toEqual({ ok: true, cellCount: 3 })
    const overrides = (await file('video')).meta.trackOverrides as Record<string, any>
    // Both rows draw the file's rows again; a colour the person chose stays.
    expect(overrides).not.toHaveProperty('source-subtitles')
    expect(overrides['target-subtitles']).toEqual({ color: 'amber' })
    expect(overrides).not.toHaveProperty('episode')
    // What they showed is still on the timeline, as its own track.
    const moved = Object.values(overrides).filter(o => o.contentFileId?.startsWith('old-'))
    expect(moved).toEqual(expect.arrayContaining([
      { kind: 'source-subtitles', name: 'Old source', contentFileId: 'old-source' },
      { kind: 'target-subtitles', name: 'Old target', contentFileId: 'old-target' },
    ]))
    expect(moved).toHaveLength(2)
    expect(overrides.other).toEqual(PARENT_META.trackOverrides.other)
    // A retry is answered from the receipt and moves nothing twice.
    const before = (await store.rows('events')).length
    expect(await promoteCaptionsToRows(store.db, existingTrack())).toMatchObject({ ok: true })
    expect(await store.rows('events')).toHaveLength(before)
    expect(await store.pg.query(`SELECT * FROM seq_allocations`).then(r => r.rows)).toHaveLength(0)
  })

  it('replays a lost response from its receipt', async () => {
    await attachAsTrack('episode', {
      kind: 'source-subtitles', name: 'Episode captions', contentFileId: 'cues',
    })
    await promoteCaptionsToRows(store.db, existingTrack())
    expect(await promoteCaptionsToRows(store.db, existingTrack()))
      .toEqual({ ok: true, cellCount: 3 })
    expect(await store.rows('events')).toHaveLength(6)
  })
})

describe('caption rows promotion: refusals write nothing', () => {
  const cases: Array<[string, () => Promise<unknown>, () => Record<string, any>, number]> = [
    ['the file already has rows', () => store.pg.query(`INSERT INTO cells
      (project_id, file_id, cell_id, side, value, event_id, last_edit_at)
      VALUES ('p','video','media-1','source','episode.wav','media-1-create',1)`),
    newCaptions, 409],
    ['the file has no linked video', () => store.pg.query(`UPDATE files
      SET meta = (meta::jsonb - 'coreMediaUrl')::text WHERE id = 'video'`), newCaptions, 409],
    ['the file is deleted', () => store.pg.query(
      `UPDATE files SET deleted_at = 5 WHERE id = 'video'`), newCaptions, 409],
    ['the person is below maintainer', async () => {}, () => ({ ...newCaptions(), role: 500 }), 403],
    ['the content belongs to another timeline', () => store.pg.query(
      `UPDATE files SET anchor_file_id = 'elsewhere' WHERE id = 'cues'`), newCaptions, 409],
    ['the content is an ordinary file', () => store.pg.query(
      `UPDATE files SET role = 'source' WHERE id = 'cues'`), newCaptions, 409],
    ['staged content is already live without a track', () => store.pg.query(
      `UPDATE files SET deleted_at = NULL WHERE id = 'cues'`), newCaptions, 409],
    ['staged content is already bound to a track', () => store.pg.query(`UPDATE files
      SET meta = jsonb_set(meta::jsonb, '{trackOverrides,other,contentFileId}', '"cues"')::text
      WHERE id = 'video'`), newCaptions, 409],
    ['the track points at different content', () => attachAsTrack('episode', {
      kind: 'source-subtitles', name: 'Episode', contentFileId: 'other-cues',
    }), existingTrack, 409],
    ['the named track does not exist', () => store.pg.query(
      `UPDATE files SET deleted_at = NULL WHERE id = 'cues'`), existingTrack, 409],
    ['the track is a target text track', () => attachAsTrack('episode', {
      kind: 'target-subtitles', name: 'Episode', contentFileId: 'cues',
    }), existingTrack, 400],
    ['the content is not captions', () => store.pg.query(
      `UPDATE files SET kind = 'txt' WHERE id = 'cues'`), newCaptions, 400],
    ['the content is empty', () => store.pg.query(
      `DELETE FROM cells WHERE file_id = 'cues'`), newCaptions, 409],
    ['a retire id is missing', async () => {}, () => {
      const input = existingTrack()
      delete (input.promotion as Record<string, unknown>).retireEventId
      return input
    }, 400],
    ['two event ids are the same', async () => {}, () => {
      const input = existingTrack()
      input.promotion.deleteEventId = input.promotion.genesisEventId
      return input
    }, 400],
    ['the content is the file itself', async () => {}, () => {
      const input = newCaptions()
      input.promotion.contentFileId = 'video'
      return input
    }, 400],
    ['an unknown key is sent', async () => {}, () => ({ ...newCaptions(),
      promotion: { ...newCaptions().promotion, name: 'x' } }), 400],
  ]
  it.each(cases)('when %s', async (_label, arrange, input, status) => {
    await arrange()
    const before = await file('video')
    expect(await promoteCaptionsToRows(store.db, input() as any))
      .toMatchObject({ ok: false, status })
    expect(await store.rows('events')).toHaveLength(0)
    expect(await file('video')).toEqual(before)
    const pending = await store.pg.query(`SELECT * FROM seq_allocations`)
    expect(pending.rows).toHaveLength(0)
  })

  it('refuses when the captions change between sizing and copying', async () => {
    const racing = Object.create(store.db)
    racing.transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
      await store.pg.query(`INSERT INTO cells
        (project_id, file_id, cell_id, side, value, start_ms, end_ms, event_id, last_edit_at)
        VALUES ('p','cues','cue-late','source','Late caption',6000,7000,'late',1)`)
      return store.db.transaction!(fn as never)
    }
    expect(await promoteCaptionsToRows(racing, newCaptions()))
      .toMatchObject({ ok: false, status: 409, reason: 'the captions changed, try again' })
    expect(await parentRows()).toHaveLength(0)
  })

  it('rolls every write back when the event log refuses one', async () => {
    await store.pg.exec(`CREATE FUNCTION reject_caption_retire() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.kind = 'file.delete' THEN RAISE EXCEPTION 'Simulated storage failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER reject_caption_retire BEFORE INSERT ON events
        FOR EACH ROW EXECUTE FUNCTION reject_caption_retire();`)
    try {
      await attachAsTrack('episode', {
        kind: 'source-subtitles', name: 'Episode captions', contentFileId: 'cues',
      })
      const before = await file('video')
      await expect(promoteCaptionsToRows(store.db, existingTrack()))
        .rejects.toThrow('Simulated storage failure')
      expect(await file('video')).toEqual(before)
      expect(await parentRows()).toHaveLength(0)
      expect(await store.rows('events')).toHaveLength(0)
      expect((await file('cues')).deleted_at).toBeNull()
    } finally {
      await store.pg.exec(`DROP TRIGGER reject_caption_retire ON events;
        DROP FUNCTION reject_caption_retire();`)
    }
  })
})

describe('caption rows promotion through POST /import', () => {
  const env = () => ({ AQUILLA_PG: store.db, SYNC_SECRET_KEY: SECRET })
  async function post(fileId: string, body: Record<string, unknown>, role = 600) {
    const token = await makeTestToken(SECRET, { projectId: 'p', fileId, role })
    const response = await handleBulkImportRequest(new Request('https://worker/import', {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ projectId: 'p', fileId, cells: [], ...body }),
    }), env())
    return response!
  }

  it('promotes from the parent-scoped completion request', async () => {
    const response = await post('video', { complete: true,
      captionPromotion: newCaptions().promotion })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ accepted: 3, fileId: 'video' })
    expect((await file('video')).kind).toBe('srt')
  })

  it.each([
    ['a reveal id', { publishEventId: 'reveal' }],
    ['a linked picture', { video: { id: 'v', coreMediaUrl: YOUTUBE }, publishEventId: 'r' }],
    ['a track publication', { trackPublication: { contentFileId: 'cues', trackId: 't',
      eventId: 'e', name: 'n' } }],
    ['cells', { cells: [{ id: 'e1', cellId: 'c1', value: 'x' }] }],
  ])('refuses a promotion mixed with %s', async (_label, extra) => {
    const response = await post('video', { complete: true,
      captionPromotion: newCaptions().promotion, ...extra })
    expect(response.status).toBe(400)
    expect(await store.rows('events')).toHaveLength(0)
  })

  it('reports a refusal with its status', async () => {
    const response = await post('video', { complete: true,
      captionPromotion: newCaptions().promotion }, 500)
    expect(response.status).toBe(403)
  })

  it('rebuilds to the same files and rows the live promotion wrote', async () => {
    await store.reset()
    await store.pg.query(`INSERT INTO project_settings (project_id, settings)
      VALUES ('p', '{"allowTrackEditing":true}')`)
    // The whole history goes through the real routes, so the log is complete:
    // a link-only video, a caption track attached the old way, then promotion.
    expect((await post('v2', { file: { id: 'v2-create', name: 'Episode two',
      fileType: 'video', kind: 'video', role: 'source', orderedBy: 'time' } })).status).toBe(200)
    expect((await post('v2', { complete: true, publishEventId: 'v2-reveal',
      video: { id: 'v2-video', coreMediaUrl: YOUTUBE } })).status).toBe(200)
    expect((await post('c2', { stageEventId: 'c2-stage', file: { id: 'c2-create',
      name: 'captions.srt', fileType: 'srt', kind: 'srt', role: 'timeline-content',
      anchorFileId: 'v2', orderedBy: 'time', importFormat: 'srt',
      parserVersion: 'builtin:srt@1', importManifest: { profileId: 'builtin:srt' } },
    cells: [
      { id: 'c2-e1', cellId: 'late', anchorCellId: 'early', value: 'Later caption',
        type: 'cue', startMs: 2000, endMs: 3000, sequenceIndex: 1 },
      { id: 'c2-e0', cellId: 'early', value: 'Earlier caption', type: 'cue',
        startMs: 0, endMs: 1000, sequenceIndex: 0, metadata: { speaker: 'Ana' } },
    ] })).status).toBe(200)
    expect((await post('c2', { complete: true })).status).toBe(200)
    expect((await post('v2', { complete: true, publishEventId: 'c2-reveal',
      trackPublication: { contentFileId: 'c2', trackId: 'episode', eventId: 'c2-bind',
        name: 'Episode captions' } })).status).toBe(200)
    await store.pg.query(`UPDATE project_settings SET settings = '{}'`)
    expect((await post('v2', { complete: true, captionPromotion: {
      contentFileId: 'c2', trackId: 'episode', genesisEventId: 'v2-rows',
      retireEventId: 'v2-retire', deleteEventId: 'c2-delete',
    } })).status).toBe(200)

    const snapshot = async () => ({
      files: (await store.pg.query<Record<string, any>>(`SELECT id, name, role, kind, anchor_file_id,
        deleted_at, event_id, cell_count, meta::jsonb AS meta FROM files ORDER BY id`)).rows,
      cells: (await store.pg.query<Record<string, any>>(`SELECT file_id, cell_id, side, value, type, start_ms,
        end_ms, sequence_index, anchor_cell_id, metadata, event_id, last_edit_at
        FROM cells ORDER BY file_id, start_ms`)).rows,
    })
    const live = await snapshot()
    const v2 = live.files.find(row => row.id === 'v2')!
    expect(v2).toMatchObject({ kind: 'srt', cell_count: 2, event_id: 'v2-retire' })
    expect(v2.meta.coreMediaUrl).toBe(YOUTUBE)
    expect(v2.meta.trackOverrides).toEqual({})
    expect(live.cells.filter(row => row.file_id === 'v2').map(row => row.value))
      .toEqual(['Earlier caption', 'Later caption'])

    const rebuild = await handleRebuildProjectionRequest(new Request(
      'https://worker/admin/projects/p/rebuild-projection',
      { method: 'POST', headers: { Authorization: `Bearer ${SECRET}` } },
    ), env())
    expect(rebuild?.status).toBe(200)
    expect(await snapshot()).toEqual(live)
  })
})
