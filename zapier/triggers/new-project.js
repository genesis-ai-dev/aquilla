'use strict';

const { get, rows } = require('../lib/api');
const { orgField } = require('../lib/fields');

// Zapier treats the first item as the newest and dedupes on `id`.
// `sort=created` makes the API list newest first (the default is by name,
// which would bury a new project under older ones).
const perform = async (z, bundle) => {
  const params = { sort: 'created' };
  if (bundle.inputData.orgId) params.orgId = bundle.inputData.orgId;
  return rows(await get(z, '/projects', params));
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
      role_source: 'member',
    },
    outputFields: [
      { key: 'id', label: 'Project ID' },
      { key: 'name', label: 'Project name' },
      { key: 'org_id', label: 'Organization ID' },
      { key: 'role_source', label: 'Your access (creator, member or org)' },
    ],
  },
};
