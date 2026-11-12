'use strict';

const { enc, get, rows } = require('../lib/api');
const { projectField } = require('../lib/fields');

// Staged plans waiting for a person to approve them. Only maintainers and
// above can see this list (others get 403), because they are the ones who approve.
const perform = async (z, bundle) => {
  const body = await get(z, `/projects/${enc(bundle.inputData.projectId)}/changesets/pending`);
  return rows(body).map((c) => ({ ...c, projectId: bundle.inputData.projectId }));
};

module.exports = {
  key: 'changeset_pending',
  noun: 'Changeset',
  display: {
    label: 'Changeset Needs Approval',
    description:
      'Triggers when an automation or AI agent proposes changes to a project that a person must approve.',
  },
  operation: {
    inputFields: [
      { ...projectField, helpText: 'You must be a Maintainer or above on this project.' },
    ],
    perform,
    sample: {
      id: '01929c4e-7b1a-7c3e-9f00-0000000000aa',
      projectId: 'prj_123',
      createdAt: '2026-10-16T14:05:00.000Z',
      summary: { command: 'SetTranslation', translationsAdded: 1, translationsModified: 2 },
      author: 'alex.translator',
      approvalUrl: 'https://aquilla.app/project/prj_123/changesets/01929c4e-7b1a-7c3e-9f00-0000000000aa',
    },
    outputFields: [
      { key: 'id', label: 'Changeset ID' },
      { key: 'projectId', label: 'Project ID' },
      { key: 'createdAt', label: 'Created at', type: 'datetime' },
      { key: 'summary__command', label: 'Change type' },
      { key: 'summary__translationsAdded', label: 'Translations added', type: 'integer' },
      { key: 'summary__translationsModified', label: 'Translations changed', type: 'integer' },
      { key: 'author', label: 'Proposed by' },
      { key: 'approvalUrl', label: 'Approval link' },
    ],
  },
};
