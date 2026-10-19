'use strict';

const { enc, get, rows, projectDetail } = require('../lib/api');

// Hidden triggers that only feed dropdowns in other steps.

const hidden = (key, noun, perform, outputFields, sample) => ({
  key,
  noun,
  display: { label: `List ${noun}s`, description: `Lists ${noun.toLowerCase()}s for dropdowns.`, hidden: true },
  operation: { perform, sample, outputFields },
});

const org = hidden(
  'org',
  'Organization',
  async (z) => rows(await get(z, '/orgs')).map((o) => ({ id: o.id, name: o.name || o.id })),
  [{ key: 'id', label: 'Organization ID' }, { key: 'name', label: 'Name' }],
  { id: 'org_123', name: 'Bible Translators Inc.' },
);

const project = hidden(
  'project',
  'Project',
  async (z, bundle) => {
    const params = bundle.inputData.orgId ? { orgId: bundle.inputData.orgId } : undefined;
    return rows(await get(z, '/projects', params)).map((p) => ({ id: p.id, name: p.name || p.id }));
  },
  [{ key: 'id', label: 'Project ID' }, { key: 'name', label: 'Name' }],
  { id: 'prj_123', name: 'Mark in Tok Pisin' },
);

const file = hidden(
  'file',
  'File',
  async (z, bundle) => {
    if (!bundle.inputData.projectId) return [];
    const body = await get(z, `/projects/${enc(bundle.inputData.projectId)}/files`, { limit: 500 });
    // File rows are keyed `fileId` (they come from the SPA's files route), not `id`.
    // An entry without an id would leave every fileId input empty, so drop it.
    return rows(body)
      .map((f) => ({ id: f.fileId ?? f.id, name: f.name || f.fileId || f.id }))
      .filter((f) => f.id);
  },
  [{ key: 'id', label: 'File ID' }, { key: 'name', label: 'Name' }],
  { id: 'fil_123', name: 'MRK.usfm' },
);

const lane = hidden(
  'lane',
  'Lane',
  async (z, bundle) => {
    if (!bundle.inputData.projectId) return [];
    const detail = await projectDetail(z, bundle.inputData.projectId);
    // Only target lanes take translations and drafts.
    return (detail.lanes || [])
      .filter((l) => l.role === 'target')
      .map((l) => ({ id: l.id, name: l.language ? `${l.name} (${l.language})` : l.name, language: l.language }));
  },
  [{ key: 'id', label: 'Lane ID' }, { key: 'name', label: 'Name' }, { key: 'language', label: 'Language' }],
  { id: 'lan_123', name: 'Tok Pisin (tpi)', language: 'tpi' },
);

module.exports = { org, project, file, lane };
