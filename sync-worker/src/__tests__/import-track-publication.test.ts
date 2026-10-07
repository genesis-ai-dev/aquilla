import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { publishImportedTrack } from '../events/import-track-publication'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { handleBulkImportRequest } from '../events/import-route'
import { makeTestToken } from './helpers/auth'

let store: TestDb
beforeAll(async () => { store = await makeTestDb() })
afterAll(async () => { await store?.close() })
beforeEach(async () => {
  await store.reset()
  await store.pg.query(`INSERT INTO project_settings (project_id, settings)
    VALUES ('p', '{"allowTrackEditing":true}')`)
  await store.pg.query(`INSERT INTO files
    (id, project_id, name, role, anchor_file_id, deleted_at, meta, event_id)
    VALUES ('media', 'p', 'Media', 'source', NULL, NULL, '{}', 'media-create'),
      ('cues', 'p', 'Captions', 'timeline-content', 'media', 1, '{}', 'cues-create')`)
  await store.pg.query(`INSERT INTO cells
    (project_id,file_id,cell_id,side,value,event_id,last_edit_at)
    VALUES ('p','cues','cue-1','source','First phrase','genesis',1),
      ('p','media','original','source','Original wording','original-event',1)`)
})

const args = () => ({
  projectId: 'p', fileId: 'media', author: 'alice', role: 600,
  clientTs: 2, publishEventId: 'publish-cues',
  publication: {
    contentFileId: 'cues', trackId: 'new-captions',
    eventId: 'bind-cues', name: 'Reviewed captions',
  },
})

async function parentMeta() {
  const result = await store.pg.query<{ meta: Record<string, unknown> }>(
    `SELECT meta::jsonb AS meta FROM files WHERE id='media'`,
  )
  return result.rows[0].meta
}

describe('atomic imported text track publication', () => {
  it('accepts publication through the parent-scoped import route', async () => {
    const token = await makeTestToken('track-import-secret', {
      projectId: 'p', fileId: 'media', role: 600,
    })
    const response = await handleBulkImportRequest(new Request('https://worker/import', {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ projectId: 'p', fileId: 'media', cells: [],
        complete: true, publishEventId: 'publish-cues',
        trackPublication: args().publication }),
    }), { AQUILLA_PG: store.db, SYNC_SECRET_KEY: 'track-import-secret' })
    expect(response?.status).toBe(200)
    expect(await parentMeta()).toMatchObject({ trackOverrides: {
      'new-captions': { contentFileId: 'cues' },
    } })
    expect((await store.rows('files')).find(row => row.id === 'cues')?.deleted_at)
      .toBeNull()
  })

  it('reveals its cue file and binds a new track while preserving original cells', async () => {
    expect(await publishImportedTrack(store.db, args())).toEqual({ ok: true })
    expect(await parentMeta()).toMatchObject({ trackOverrides: {
      'new-captions': { kind: 'source-subtitles',
        name: 'Reviewed captions', contentFileId: 'cues' },
    } })
    const files = await store.rows('files')
    expect(files.find(row => row.id === 'cues')?.deleted_at).toBeNull()
    expect((await store.rows('cells')).find(row => row.cell_id === 'original')?.value)
      .toBe('Original wording')
    expect((await store.rows('events')).map(row => row.kind).sort())
      .toEqual(['file.restore', 'file.track.set'])
  })

  it('does not silently replace an existing track', async () => {
    await store.pg.query(`UPDATE files SET meta=
      '{"trackOverrides":{"new-captions":{"kind":"source-subtitles","name":"Existing"}}}'
      WHERE id='media'`)
    expect(await publishImportedTrack(store.db, args()))
      .toMatchObject({ ok: false, status: 409 })
    expect((await store.rows('files')).find(row => row.id === 'cues')?.deleted_at)
      .not.toBeNull()
    expect(await store.rows('events')).toHaveLength(0)
  })

  it('rolls back the reference and event log if revealing captions fails', async () => {
    await store.pg.exec(`CREATE FUNCTION reject_caption_reveal() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.id='cues' AND NEW.deleted_at IS NULL THEN
          RAISE EXCEPTION 'Simulated storage failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER reject_caption_reveal BEFORE UPDATE ON files
        FOR EACH ROW EXECUTE FUNCTION reject_caption_reveal();`)
    try {
      await expect(publishImportedTrack(store.db, args()))
        .rejects.toThrow('Simulated storage failure')
      expect(await parentMeta()).toEqual({})
      expect(await store.rows('events')).toHaveLength(0)
      expect((await store.rows('files')).find(row => row.id === 'cues')?.deleted_at)
        .not.toBeNull()
    } finally {
      await store.pg.exec(`DROP TRIGGER reject_caption_reveal ON files;
        DROP FUNCTION reject_caption_reveal();`)
    }
  })

  it('requires the explicit overwrite count to match the current track', async () => {
    const input = args()
    input.publication.trackId = 'source-subtitles'
    const publication = { ...input.publication,
      overwrite: { contentFileId: null, segmentCount: 2 } }
    expect(await publishImportedTrack(store.db, { ...input, publication }))
      .toMatchObject({ ok: false, status: 409 })
    expect(await store.rows('events')).toHaveLength(0)
    publication.overwrite.segmentCount = 1
    expect(await publishImportedTrack(store.db, { ...input, publication }))
      .toEqual({ ok: true })
  })

  it('counts target text track segments from their source cue geometry', async () => {
    const input = args()
    input.publication.trackId = 'target-subtitles'
    expect(await publishImportedTrack(store.db, { ...input, publication: {
      ...input.publication, overwrite: { contentFileId: null, segmentCount: 1 },
    } })).toEqual({ ok: true })
  })

  it('keeps a later edit when a lost publication response is retried', async () => {
    expect(await publishImportedTrack(store.db, args())).toEqual({ ok: true })
    await store.pg.query(`UPDATE files SET meta=jsonb_set(meta::jsonb,
      '{trackOverrides,new-captions,name}', '"Later rename"') WHERE id='media'`)
    expect(await publishImportedTrack(store.db, args())).toEqual({ ok: true })
    expect(await parentMeta()).toMatchObject({ trackOverrides: {
      'new-captions': { name: 'Later rename' },
    } })
    expect(await store.rows('events')).toHaveLength(2)
  })

  it('rejects reusing a publication event for a different track', async () => {
    await publishImportedTrack(store.db, args())
    const input = args()
    input.publication.trackId = 'another-track'
    expect(await publishImportedTrack(store.db, input))
      .toMatchObject({ ok: false, status: 409 })
  })

  it.each(['foreign', 'ordinary', 'live', 'empty'])(
    'refuses a cue file that cannot be published: %s', async variant => {
      if (variant === 'foreign') await store.pg.query(
        `UPDATE files SET anchor_file_id='other-media' WHERE id='cues'`)
      if (variant === 'ordinary') await store.pg.query(
        `UPDATE files SET role='source' WHERE id='cues'`)
      if (variant === 'live') await store.pg.query(
        `UPDATE files SET deleted_at=NULL WHERE id='cues'`)
      if (variant === 'empty') await store.pg.query(
        `DELETE FROM cells WHERE file_id='cues'`)
      expect(await publishImportedTrack(store.db, args()))
        .toMatchObject({ ok: false })
      expect(await store.rows('events')).toHaveLength(0)
    },
  )

  it('enforces both the maintainer role and project track setting', async () => {
    expect(await publishImportedTrack(store.db, { ...args(), role: 500 }))
      .toMatchObject({ ok: false, status: 403 })
    await store.pg.query(`UPDATE project_settings SET settings='{}'`)
    expect(await publishImportedTrack(store.db, args()))
      .toMatchObject({ ok: false, status: 403 })
    expect(await store.rows('events')).toHaveLength(0)
  })
})
