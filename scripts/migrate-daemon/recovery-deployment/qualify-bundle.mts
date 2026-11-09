import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildCellAudioEvents } from '../../../src/lib/migrate/audio-copy.ts';
import { Client } from 'pg';
const connectionString = process.env.AUDIO_RECOVERY_CANARY_DATABASE_URL;
if (!connectionString)
    throw Error('Set AUDIO_RECOVERY_CANARY_DATABASE_URL to an isolated local database');
const database = new URL(connectionString);
if (database.hostname !== '127.0.0.1' || !database.pathname.startsWith('/aquilla_2218_canary'))
    throw Error('Local isolated canary database required');
const pg = new Client({ connectionString });
await pg.connect();
const base = 'http://127.0.0.1:19228', headers = { Authorization: 'Bearer local-2218-test', 'Content-Type': 'application/json' };
async function ingest(projectId, events) { const r = await fetch(base + '/migrate/ingest', { method: 'POST', headers, body: JSON.stringify({ projectId, events }) }); const txt = await r.text(); assert.equal(r.status, 200, txt); return JSON.parse(txt); }
const cap = await fetch(base + '/migrate/ingest', { headers });
assert.equal(cap.status, 200, await cap.clone().text());
assert((await cap.json()).capabilities.includes('audio-history-attach-v1'));
await pg.query("INSERT INTO users(id,username,email,password_hash) VALUES(2218,'canary','canary@example.invalid','unused') ON CONFLICT DO NOTHING");
const results = [];
const run = Date.now();
for (const state of ['selected', 'none', 'deleted']) {
    const projectId = 'recovery-' + state + '-' + run, fileId = 'file-' + state + '-' + run, cellId = 'cell-' + state;
    await pg.query('INSERT INTO projects(id,name,created_by) VALUES($1,$1,2218)', [projectId]);
    await pg.query("INSERT INTO files(id,project_id,name,event_id) VALUES($1,$2,'Test','seed')", [fileId, projectId]);
    const ordinary = { id: 'app-' + state + '-' + run, kind: 'cell.audio.attach', fileId, cellId, author: 'app-user', clientTs: 1700000000000, payload: { audioId: state === 'deleted' ? 'old.wav' : 'current.wav', url: 'frontier-audio://current.wav', slot: 'recording' } };
    await ingest(projectId, [ordinary]);
    if (state !== 'selected')
        await ingest(projectId, [{ ...ordinary, id: 'state-' + state + '-' + run, kind: state === 'deleted' ? 'cell.audio.remove' : 'cell.audio.select', payload: { audioId: state === 'deleted' ? 'old.wav' : null, slot: 'recording' } }]);
    const rows = async () => (await pg.query('SELECT * FROM cell_audio WHERE project_id=$1 ORDER BY audio_id', [projectId])).rows;
    const before = await rows();
    const events = buildCellAudioEvents(cellId, [{ legacyAudioId: 'old', aquillaAudioId: 'old.wav', diskRelPath: '.project/attachments/files/old.wav', slot: 'recording', createdBy: 'original-author', createdAt: 1600000000000 }], null, { projectId, fileId, fallbackAuthor: 'fallback', fallbackTs: 1800000000000, preserveUnselectedHistory: true });
    const ack = await ingest(projectId, events);
    const after = await rows();
    for (const row of before)
        assert.deepEqual(after.find(r => r.audio_id === row.audio_id), row);
    if (state !== 'deleted') {
        const old = after.find(r => r.audio_id === 'old.wav');
        assert.equal(old.selected, 0);
        assert.equal(old.created_by, 'original-author');
        assert.equal(Number(old.created_ts), 1600000000000);
    }
    const retry = await ingest(projectId, events);
    assert.equal(retry.accepted, 0);
    assert.deepEqual(await rows(), after);
    await pg.query('DELETE FROM cell_audio WHERE project_id=$1', [projectId]);
    const rb = await fetch(base + `/admin/projects/${projectId}/rebuild-projection?fullReplay=1`, { method: 'POST', headers });
    assert.equal(rb.status, 200, await rb.clone().text());
    assert.deepEqual(await rows(), after);
    results.push({ state, accepted: ack.accepted, replayed: retry.replayed, rows: after.length, rebuildMatches: true });
}
{
    const { selectedAudioProjectionRepairEvent } = await import('../../../src/lib/migrate/audio.ts');
    const projectId = 'projection-repair-' + run, fileId = 'repair-file-' + run, cellId = 'repair-cell';
    await pg.query('INSERT INTO projects(id,name,created_by) VALUES($1,$1,2218)', [projectId]);
    await pg.query("INSERT INTO files(id,project_id,name,event_id) VALUES($1,$2,'Test','seed')", [fileId, projectId]);
    const take = { legacyAudioId: 'trimmed', aquillaAudioId: 'trimmed.webm', diskRelPath: '.project/attachments/files/trimmed.webm', slot: 'recording', createdAt: 1600000000000, validatedBy: [{ username: 'original-validator', creationTimestamp: 1600000001000, updatedTimestamp: 1600000001000, isDeleted: false }] };
    const opts = { projectId, fileId, fallbackAuthor: 'legacy-import', fallbackTs: 1600000000000 };
    const original = buildCellAudioEvents(cellId, [take], take.aquillaAudioId, opts);
    await ingest(projectId, original);
    await pg.query('DELETE FROM cell_audio WHERE project_id=$1', [projectId]);
    assert.equal((await ingest(projectId, original)).accepted, 0);
    const repair = selectedAudioProjectionRepairEvent(cellId, take, opts, { originalEventId: original[0].id, sourceOid: 'a'.repeat(64), sourceSelectedAudioId: take.legacyAudioId });
    const ack = await ingest(projectId, [repair]);
    assert.equal(ack.accepted, 1);
    const rows = async () => (await pg.query('SELECT * FROM cell_audio WHERE project_id=$1 ORDER BY audio_id', [projectId])).rows;
    const after = await rows();
    assert.equal(after[0].selected, 1);
    assert.equal(after[0].validator_count, 1);
    assert.equal(after[0].event_id, original[0].id);
    assert.equal((await ingest(projectId, [repair])).accepted, 0);
    await pg.query('DELETE FROM cell_audio WHERE project_id=$1', [projectId]);
    const rb = await fetch(base + `/admin/projects/${projectId}/rebuild-projection?fullReplay=1`, { method: 'POST', headers });
    assert.equal(rb.status, 200, await rb.clone().text());
    assert.deepEqual(await rows(), after);
    results.push({ state: 'missing-projection', accepted: 1, originalEventPreserved: true, votesPreserved: true, rebuildMatches: true });
}
await pg.end();
const report = { at: new Date().toISOString(), target: 'isolated local PostgreSQL via patched deployed Worker bundle', productionWrites: 0, results };
if (process.argv[2])
    fs.writeFileSync(process.argv[2], JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
