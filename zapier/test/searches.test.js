'use strict';

const { App, appTester, nock, api, bundleWith, API } = require('./helpers');

afterEach(() => nock.cleanAll());

const perform = (key, inputData) => appTester(App.searches[key].operation.perform, bundleWith(inputData));

describe('Find Project', () => {
  it('puts an exact name match ahead of partial matches, so "Mark" finds Mark before "Mark (old)"', async () => {
    api()
      .get(`${API}/projects`)
      .reply(200, {
        data: [
          { id: 'p_old', name: 'Mark (old)' },
          { id: 'p_luke', name: 'Luke' },
          { id: 'p_mark', name: 'mark' },
        ],
      });

    const results = await perform('find_project', { name: ' Mark ' });

    expect(results.map((p) => p.id)).toEqual(['p_mark', 'p_old']);
  });

  it('returns an empty list when nothing matches, so Zapier can branch on "not found"', async () => {
    api().get(`${API}/projects`).query({ orgId: 'org_1' }).reply(200, { data: [{ id: 'p', name: 'Luke' }] });

    expect(await perform('find_project', { name: 'Mark', orgId: 'org_1' })).toEqual([]);
  });
});

describe('Find Cell', () => {
  it('returns the cellId and fileId the write actions need', async () => {
    api()
      .get(`${API}/projects/prj_1/search`)
      .query({ q: 'MRK 1:1', side: 'source', limit: '10' })
      .reply(200, {
        data: [
          {
            cellId: 'c_1', fileId: 'f_1', side: 'source', value: 'The beginning', snippet: '<mark>The</mark> beginning',
            rank: -1.2, pairedValue: 'Stat', canonicalRef: 'MRK 1:1',
          },
        ],
        nextCursor: null,
      });

    const results = await perform('find_cell', { projectId: 'prj_1', query: 'MRK 1:1' });

    expect(results).toEqual([
      {
        id: 'f_1:c_1', cellId: 'c_1', fileId: 'f_1', projectId: 'prj_1', reference: 'MRK 1:1',
        side: 'source', value: 'The beginning', pairedValue: 'Stat',
      },
    ]);
  });

  it('searches translations when asked', async () => {
    const scope = api()
      .get(`${API}/projects/prj_1/search`)
      .query({ q: 'gutnius', side: 'target', limit: '10' })
      .reply(200, { data: [] });

    expect(await perform('find_cell', { projectId: 'prj_1', query: 'gutnius', side: 'target' })).toEqual([]);
    scope.done();
  });
});
