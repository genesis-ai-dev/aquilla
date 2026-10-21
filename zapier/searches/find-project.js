'use strict';

const { get, rows } = require('../lib/api');
const { orgField } = require('../lib/fields');

// GET /projects has no name filter, so match here: exact names first, then
// names that contain the search text.
const perform = async (z, bundle) => {
  const params = bundle.inputData.orgId ? { orgId: bundle.inputData.orgId } : undefined;
  const wanted = String(bundle.inputData.name || '').trim().toLowerCase();
  const projects = rows(await get(z, '/projects', params));
  const name = (p) => String(p.name || '').toLowerCase();
  const exact = projects.filter((p) => name(p) === wanted);
  const partial = projects.filter((p) => name(p) !== wanted && name(p).includes(wanted));
  return [...exact, ...partial];
};

module.exports = {
  key: 'find_project',
  noun: 'Project',
  display: {
    label: 'Find Project',
    description: 'Finds a project by name.',
  },
  operation: {
    inputFields: [
      { key: 'name', label: 'Project name', required: true, helpText: 'The whole name or part of it.' },
      orgField,
    ],
    perform,
    sample: { id: 'prj_123', name: 'Mark in Tok Pisin', org_id: 'org_123' },
    outputFields: [
      { key: 'id', label: 'Project ID' },
      { key: 'name', label: 'Project name' },
      { key: 'org_id', label: 'Organization ID' },
    ],
  },
};
