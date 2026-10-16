'use strict';

const { get, rows } = require('../lib/api');
const { orgField } = require('../lib/fields');

const createdAt = (p) => Date.parse(p.created_at || p.createdAt || '') || 0;

// Zapier treats the first item as the newest. `sort=created` asks the API for
// newest first; we sort again here in case the API ignores the parameter
// (older deployments sort by name) so a new project is never buried.
const perform = async (z, bundle) => {
  const params = { sort: 'created' };
  if (bundle.inputData.orgId) params.orgId = bundle.inputData.orgId;
  return rows(await get(z, '/projects', params))
    .slice()
    .sort((a, b) => createdAt(b) - createdAt(a));
};

module.exports = {
  key: 'new_project',
  noun: 'Project',
  display: {
    label: 'New Project',
    description: 'Triggers when a project you can see is created.',
  },
  operation: {
    inputFields: [orgField],
    perform,
    sample: {
      id: 'prj_123',
      name: 'Mark in Tok Pisin',
      org_id: 'org_123',
      created_at: '2026-10-16T14:05:00.000Z',
    },
    outputFields: [
      { key: 'id', label: 'Project ID' },
      { key: 'name', label: 'Project name' },
      { key: 'org_id', label: 'Organization ID' },
      { key: 'created_at', label: 'Created at', type: 'datetime' },
    ],
  },
};
