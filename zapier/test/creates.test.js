'use strict';

const { App, appTester, nock, api, bundleWith, API } = require('./helpers');

afterEach(() => nock.cleanAll());

const perform = (key, inputData) => appTester(App.creates[key].operation.perform, bundleWith(inputData));

const staged = (id = 'cs_1') => ({
  changeset: { id, status: 'staged' },
  summary: 'Add 1 comment',
  digest: 'd',
  approvalUrl: `https://aquilla.app/approve/${id}`,
});

const receipt = { receipt: { eventIds: ['ev_1'], appliedCount: 1, staleCount: 0, warnings: [], committedAt: '2026-10-16T14:05:00Z' } };

// Stage expects exactly `commands`, then commit answers with `commitStatus`.
const expectChangeset = (commands, commitStatus = 200, commitBody = receipt) =>
  api()
    .post(`${API}/projects/prj_1/changesets`, (body) => JSON.stringify(body) === JSON.stringify({ commands }))
    .reply(200, staged())
    .post(`${API}/projects/prj_1/changesets/cs_1/commit`)
    .reply(commitStatus, commitBody);

describe('Add Comment', () => {
  it('stages a comment.create event and commits it', async () => {
    const scope = expectChangeset([
      {
        kind: 'EmitEvents',
        events: [{ kind: 'comment.create', fileId: 'fil_1', cellId: 'MRK 1:1', payload: { body: 'Check this', parentCommentId: 'cmt_0' } }],
      },
    ]);

    const result = await perform('add_comment', {
      projectId: 'prj_1', fileId: 'fil_1', cellId: 'MRK 1:1', body: 'Check this', parentCommentId: 'cmt_0',
    });

    expect(result).toMatchObject({ status: 'committed', changesetId: 'cs_1', appliedCount: 1 });
    scope.done();
  });

  // An ask-mode connection is designed to stop at a human approval. Throwing
  // here would mark the Zap run as failed, retry it, and after repeated
  // "failures" Zapier turns the Zap off. Returning the link lets the Zap carry
  // on, e.g. to post the approval link in Slack.
  it('returns the approval link instead of failing when the connection is in ask mode (428)', async () => {
    const scope = expectChangeset(
      [{ kind: 'EmitEvents', events: [{ kind: 'comment.create', fileId: 'fil_1', cellId: 'c1', payload: { body: 'Hi' } }] }],
      428,
      { error: { code: 'confirmation_required', message: 'ask-mode changeset requires a valid, unconsumed human approval' } },
    );

    const result = await perform('add_comment', { projectId: 'prj_1', fileId: 'fil_1', cellId: 'c1', body: 'Hi' });

    expect(result).toEqual({
      status: 'awaiting_approval',
      changesetId: 'cs_1',
      summary: 'Add 1 comment',
      approvalUrl: 'https://aquilla.app/approve/cs_1',
    });
    scope.done();
  });

  it('still fails on a real commit error such as a stale plan', async () => {
    expectChangeset(
      [{ kind: 'EmitEvents', events: [{ kind: 'comment.create', fileId: 'fil_1', cellId: 'c1', payload: { body: 'Hi' } }] }],
      409,
      { error: { code: 'plan_stale', message: 'the cell changed since this plan was staged' } },
    );

    await expect(perform('add_comment', { projectId: 'prj_1', fileId: 'fil_1', cellId: 'c1', body: 'Hi' })).rejects.toThrow(
      'the cell changed since this plan was staged',
    );
  });

  it('fails without committing when staging is refused (e.g. a read-only connection)', async () => {
    api().post(`${API}/projects/prj_1/changesets`).reply(403, { error: { code: 'scope_denied', message: 'read-only credential' } });

    await expect(perform('add_comment', { projectId: 'prj_1', fileId: 'f', cellId: 'c', body: 'x' })).rejects.toThrow('read-only credential');
    // No commit interceptor was registered; nock would have thrown on an unexpected commit call.
  });
});

describe('Set Translation', () => {
  it('stages SetTranslation with the lane id and the text as `value`', async () => {
    const scope = expectChangeset([{ kind: 'SetTranslation', fileId: 'fil_1', cellId: 'MRK 1:1', laneId: 'lan_tpi', value: 'Gutnius' }]);

    const result = await perform('set_translation', {
      projectId: 'prj_1', fileId: 'fil_1', cellId: 'MRK 1:1', laneId: 'lan_tpi', value: 'Gutnius',
    });

    expect(result.status).toBe('committed');
    scope.done();
  });
});

describe('AI-Draft Cells', () => {
  it('stages DraftCells with an explicit cell list, because the API refuses wildcards', async () => {
    const scope = expectChangeset([
      { kind: 'DraftCells', fileId: 'fil_1', cellIds: ['c1', 'c2'], laneId: 'lan_tpi', instructions: 'Use simple words' },
    ]);

    await perform('draft_cells', {
      projectId: 'prj_1', fileId: 'fil_1', cellIds: ['c1', '', 'c2'], laneId: 'lan_tpi', instructions: 'Use simple words',
    });

    scope.done();
  });

  it('leaves out empty instructions', async () => {
    const scope = expectChangeset([{ kind: 'DraftCells', fileId: 'fil_1', cellIds: ['c1'], laneId: 'lan_tpi' }]);

    await perform('draft_cells', { projectId: 'prj_1', fileId: 'fil_1', cellIds: 'c1', laneId: 'lan_tpi', instructions: '' });

    scope.done();
  });
});

describe('Upload & Import File', () => {
  it('uploads the bytes, stages the import, and commits it, without sending the Aquilla token to the file host', async () => {
    const fileHost = nock('https://files.example.com', { badheaders: ['authorization'] })
      .get('/uploads/MRK.usfm')
      .reply(200, '\\id MRK\n\\c 1\n\\v 1 The beginning', { 'content-type': 'text/plain' });

    const scope = api()
      .post(`${API}/projects/prj_1/artifacts`, (body) => body.startsWith('\\id MRK'))
      .matchHeader('x-artifact-name', 'MRK.usfm')
      .matchHeader('content-type', 'text/plain')
      .reply(201, { artifactId: 'art_1', sha256: 'x', sizeBytes: 30, kind: 'source' })
      .post(`${API}/projects/prj_1/artifacts/art_1/parse`, { stage: true, fileName: 'MRK.usfm', laneId: 'lan_tpi' })
      .reply(200, { ...staged(), summary: 'Import MRK.usfm' })
      .post(`${API}/projects/prj_1/changesets/cs_1/commit`)
      .reply(200, receipt);

    const result = await perform('upload_file', {
      projectId: 'prj_1', file: 'https://files.example.com/uploads/MRK.usfm', laneId: 'lan_tpi',
    });

    expect(result).toMatchObject({ status: 'committed', artifactId: 'art_1', fileName: 'MRK.usfm', summary: 'Import MRK.usfm' });
    fileHost.done();
    scope.done();
  });

  it('returns the approval link when the import needs approval (428)', async () => {
    nock('https://files.example.com').get('/a.docx').reply(200, 'PK');
    api()
      .post(`${API}/projects/prj_1/artifacts`)
      .reply(201, { artifactId: 'art_2' })
      .post(`${API}/projects/prj_1/artifacts/art_2/parse`, { stage: true, fileName: 'Mark draft.docx', fileType: 'docx' })
      .reply(200, staged())
      .post(`${API}/projects/prj_1/changesets/cs_1/commit`)
      .reply(428, { error: { code: 'confirmation_required', message: 'needs approval' } });

    const result = await perform('upload_file', {
      projectId: 'prj_1', file: 'https://files.example.com/a.docx', fileName: 'Mark draft.docx', fileType: 'docx',
    });

    expect(result).toMatchObject({ status: 'awaiting_approval', approvalUrl: 'https://aquilla.app/approve/cs_1' });
  });
});

