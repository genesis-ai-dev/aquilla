'use strict';

const { App, appTester, nock, api, bundleWith, API } = require('./helpers');

afterEach(() => nock.cleanAll());

const perform = (key, inputData) => appTester(App.triggers[key].operation.perform, bundleWith(inputData));

const event = (id, serverSeq, kind = 'comment.create', extra = {}) => ({
  id,
  kind,
  fileId: 'fil_1',
  cellId: 'MRK 1:1',
  serverSeq,
  serverTs: 1792159500000,
  author: 'u_1a2b3c4d',
  data: {},
  ...extra,
});

describe('activity triggers', () => {
  // Zapier deduplicates on `id` and treats the first item as the newest. An
  // older event ahead of a newer one, or a repeated id, would make it miss or
  // re-fire a Zap.
  it('returns events newest first with unique ids even if a page arrives out of order', async () => {
    api()
      .get(`${API}/projects/prj_1/activity`)
      .query({ kinds: 'comment.create', limit: '50' })
      .reply(200, { items: [event('e1', 10), event('e3', 30), event('e2', 20), event('e3', 30)], nextCursor: 'c' });

    const results = await perform('new_comment', { projectId: 'prj_1' });

    expect(results.map((r) => r.id)).toEqual(['e3', 'e2', 'e1']);
    expect(results[0].projectId).toBe('prj_1');
    // serverTs is epoch ms; the step adds a readable time for Zap fields.
    expect(results[0].occurredAt).toBe('2026-10-16T14:05:00.000Z');
  });

  it.each([
    ['new_comment', 'comment.create'],
    ['cell_translated', 'target.cell.commit'],
    ['cell_validated', 'cell.validate'],
    ['new_file', 'file.create'],
  ])('%s asks the feed for %s only, so other changes never fire it', async (key, kind) => {
    const scope = api()
      .get(`${API}/projects/prj_1/activity`)
      .query({ kinds: kind, limit: '50' })
      .reply(200, { items: [event('e1', 1, kind)], nextCursor: null });

    const results = await perform(key, { projectId: 'prj_1' });

    expect(results).toHaveLength(1);
    scope.done();
  });

  it('narrows to one file when the user picks one', async () => {
    const scope = api()
      .get(`${API}/projects/prj_1/activity`)
      .query({ kinds: 'comment.create', limit: '50', fileId: 'fil_9' })
      .reply(200, { items: [], nextCursor: null });

    await perform('new_comment', { projectId: 'prj_1', fileId: 'fil_9' });
    scope.done();
  });

  it('New Project Activity sends every kind the user picked', async () => {
    const scope = api()
      .get(`${API}/projects/prj_1/activity`)
      .query({ kinds: 'comment.resolve,file.rename', limit: '50' })
      // `data` is accepted as well as the feed's `items`, like every other list route.
      .reply(200, { data: [event('e1', 5, 'file.rename')] });

    const results = await perform('project_activity', { projectId: 'prj_1', kinds: ['comment.resolve', 'file.rename'] });

    expect(results.map((r) => r.kind)).toEqual(['file.rename']);
    scope.done();
  });
});

describe('New Project', () => {
  // The default order is by name, which would put a new "Acts" project below
  // older ones and Zapier would never see it as new.
  it('asks for newest-first order and keeps it', async () => {
    const scope = api()
      .get(`${API}/projects`)
      .query({ sort: 'created', orgId: 'org_1' })
      .reply(200, {
        data: [
          { id: 'p_z', name: 'Zechariah', org_id: 'org_1', role_source: 'member' },
          { id: 'p_a', name: 'Acts', org_id: 'org_1', role_source: 'org' },
        ],
        nextCursor: null,
      });

    const results = await perform('new_project', { orgId: 'org_1' });

    expect(results.map((p) => p.id)).toEqual(['p_z', 'p_a']);
    scope.done();
  });
});

describe('Changeset Needs Approval', () => {
  it('returns pending plans with the link a person uses to approve them', async () => {
    api()
      .get(`${API}/projects/prj_1/changesets/pending`)
      .reply(200, {
        data: [
          {
            id: 'cs_2',
            createdAt: '2026-10-16T14:05:00.000Z',
            summary: { command: 'SetTranslation', translationsModified: 3 },
            author: 'u_1a2b3c4d',
            approvalUrl: 'https://aquilla.app/a/cs_2',
          },
        ],
        nextCursor: null,
      });

    const results = await perform('changeset_pending', { projectId: 'prj_1' });

    expect(results).toEqual([expect.objectContaining({ id: 'cs_2', approvalUrl: 'https://aquilla.app/a/cs_2', projectId: 'prj_1' })]);
  });

  it('surfaces the API message when the user lacks the role to see approvals', async () => {
    api()
      .get(`${API}/projects/prj_1/changesets/pending`)
      .reply(403, {
        error: {
          code: 'permission_denied',
          message: 'pending changesets are visible to project maintainers and above (the people who can approve them)',
        },
      });

    // A role problem, not a dead token: the user sees why, and is not told to reconnect.
    const err = await perform('changeset_pending', { projectId: 'prj_1' }).catch((e) => e);
    expect(err.name).toBe('AppError');
    expect(err.message).toContain('maintainers and above');
  });
});

describe('dropdowns', () => {
  it('lists orgs, falling back to the id when an org has no name', async () => {
    api().get(`${API}/orgs`).reply(200, { data: [{ id: 'org_1', name: null }, { id: 'org_2', name: 'B' }] });

    expect(await perform('org', {})).toEqual([{ id: 'org_1', name: 'org_1' }, { id: 'org_2', name: 'B' }]);
  });

  it('lists projects in the chosen org', async () => {
    api().get(`${API}/projects`).query({ orgId: 'org_1' }).reply(200, { data: [{ id: 'p1', name: 'Mark' }] });

    expect(await perform('project', { orgId: 'org_1' })).toEqual([{ id: 'p1', name: 'Mark' }]);
  });

  it('lists files of the chosen project', async () => {
    api().get(`${API}/projects/p1/files`).query({ limit: '500' }).reply(200, { data: [{ id: 'f1', name: 'MRK.usfm' }] });

    expect(await perform('file', { projectId: 'p1' })).toEqual([{ id: 'f1', name: 'MRK.usfm' }]);
  });

  it('offers only target lanes, because translations and drafts cannot be written to the source', async () => {
    api()
      .get(`${API}/projects/p1`)
      .reply(200, {
        id: 'p1',
        lanes: [
          { id: 'l_src', name: 'English', language: 'en', role: 'source' },
          { id: 'l_tpi', name: 'Tok Pisin', language: 'tpi', role: 'target' },
        ],
      });

    expect(await perform('lane', { projectId: 'p1' })).toEqual([{ id: 'l_tpi', name: 'Tok Pisin (tpi)', language: 'tpi' }]);
  });

  it('returns nothing for project-scoped dropdowns before a project is chosen', async () => {
    expect(await perform('file', {})).toEqual([]);
    expect(await perform('lane', {})).toEqual([]);
  });
});
