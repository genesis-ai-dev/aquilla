'use strict';

const { enc, get, rows } = require('./api');
const { projectField, fileField } = require('./fields');

// Polling triggers on GET /projects/:pid/activity. Zapier deduplicates by `id`
// and only looks at the first page, so results must be newest first with
// unique ids. The API already sorts by serverSeq descending; we re-sort and
// drop duplicate ids so a reordered or overlapping page cannot hide new events.
// serverTs is epoch milliseconds; Zapier users want a readable time too.
const isoTime = (ms) => (Number.isFinite(Number(ms)) ? new Date(Number(ms)).toISOString() : null);

const fetchActivity = async (z, bundle, kinds) => {
  const params = { kinds: kinds.join(','), limit: 50 };
  if (bundle.inputData.fileId) params.fileId = bundle.inputData.fileId;
  const body = await get(z, `/projects/${enc(bundle.inputData.projectId)}/activity`, params);
  const seen = new Set();
  return rows(body)
    .filter((item) => item && item.id && !seen.has(item.id) && seen.add(item.id))
    .sort((a, b) => Number(b.serverSeq) - Number(a.serverSeq))
    .map((item) => ({ ...item, projectId: bundle.inputData.projectId, occurredAt: isoTime(item.serverTs) }));
};

const baseOutputFields = [
  { key: 'id', label: 'Event ID' },
  { key: 'kind', label: 'Event kind' },
  { key: 'projectId', label: 'Project ID' },
  { key: 'fileId', label: 'File ID' },
  { key: 'cellId', label: 'Cell ID' },
  { key: 'serverSeq', label: 'Sequence number', type: 'integer' },
  { key: 'serverTs', label: 'Time (milliseconds since 1970)', type: 'integer' },
  { key: 'occurredAt', label: 'Time', type: 'datetime' },
  { key: 'author', label: 'Author' },
];

const baseSample = {
  id: '01929c4e-7b1a-7c3e-9f00-000000000001',
  projectId: 'prj_123',
  fileId: 'fil_123',
  cellId: 'MRK 1:1',
  serverSeq: 4821,
  serverTs: 1792159500000,
  occurredAt: '2026-10-16T14:05:00.000Z',
  author: 'alex.translator',
};

// Build one activity trigger. `kinds` is fixed for the specific triggers; the
// generic trigger passes null and lets the user pick.
const activityTrigger = ({ key, noun, label, description, kinds, sample, outputFields = [], extraInputFields = [] }) => ({
  key,
  noun,
  display: { label, description },
  operation: {
    inputFields: [projectField, fileField(false), ...extraInputFields],
    perform: (z, bundle) => fetchActivity(z, bundle, kinds || [].concat(bundle.inputData.kinds || [])),
    sample: { ...baseSample, ...sample },
    outputFields: [...baseOutputFields, ...outputFields],
  },
});

module.exports = { activityTrigger, fetchActivity };
