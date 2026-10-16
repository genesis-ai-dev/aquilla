'use strict';

// Every action returns the same shape: either the change was applied
// ("committed") or it waits for a person in Aquilla ("awaiting_approval").
const resultSample = {
  status: 'committed',
  changesetId: '01929c4e-7b1a-7c3e-9f00-0000000000aa',
  summary: 'Add 1 comment',
  approvalUrl: 'https://aquilla.app/project/prj_123/changesets/01929c4e-7b1a-7c3e-9f00-0000000000aa',
  appliedCount: 1,
  staleCount: 0,
  committedAt: '2026-10-16T14:05:00.000Z',
  eventIds: ['01929c4e-7b1a-7c3e-9f00-000000000001'],
  warnings: [],
};

const resultOutputFields = [
  { key: 'status', label: 'Status (committed or awaiting_approval)' },
  { key: 'changesetId', label: 'Changeset ID' },
  { key: 'summary', label: 'Summary' },
  { key: 'approvalUrl', label: 'Approval link' },
  { key: 'appliedCount', label: 'Changes applied', type: 'integer' },
  { key: 'staleCount', label: 'Changes skipped as out of date', type: 'integer' },
  { key: 'committedAt', label: 'Applied at', type: 'datetime' },
];

const writeNote =
  'If you connected Aquilla in "ask" mode, the change waits for approval in Aquilla and this step returns an approval link.';

module.exports = { resultSample, resultOutputFields, writeNote };
