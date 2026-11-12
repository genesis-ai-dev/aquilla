'use strict';

const { enc, get, rows } = require('../lib/api');
const { projectField } = require('../lib/fields');

// People rarely know cell IDs, so this step turns a verse reference or a
// phrase into the cellId and fileId that the write actions need.
const perform = async (z, bundle) => {
  const { projectId, query, side } = bundle.inputData;
  const body = await get(z, `/projects/${enc(projectId)}/search`, {
    q: query,
    side: side || 'source',
    limit: 10,
  });
  return rows(body).map((hit) => ({
    id: `${hit.fileId}:${hit.cellId}`,
    cellId: hit.cellId,
    fileId: hit.fileId,
    projectId,
    reference: hit.canonicalRef || null,
    side: hit.side,
    value: hit.value,
    pairedValue: hit.pairedValue ?? null,
  }));
};

module.exports = {
  key: 'find_cell',
  noun: 'Cell',
  display: {
    label: 'Find Cell',
    description: 'Finds a cell by verse reference (like "MRK 1:1") or by words in its text.',
  },
  operation: {
    inputFields: [
      projectField,
      { key: 'query', label: 'Reference or text', required: true },
      {
        key: 'side',
        label: 'Search in',
        choices: { source: 'Source text', target: 'Translation' },
        default: 'source',
      },
    ],
    perform,
    sample: {
      id: 'fil_123:MRK 1:1',
      cellId: 'MRK 1:1',
      fileId: 'fil_123',
      projectId: 'prj_123',
      reference: 'MRK 1:1',
      side: 'source',
      value: 'The beginning of the good news about Jesus the Messiah, the Son of God.',
      pairedValue: 'Dispela em i stat bilong gutnius bilong Jisas Krais.',
    },
    outputFields: [
      { key: 'cellId', label: 'Cell ID' },
      { key: 'fileId', label: 'File ID' },
      { key: 'projectId', label: 'Project ID' },
      { key: 'reference', label: 'Reference' },
      { key: 'side', label: 'Matched in' },
      { key: 'value', label: 'Matched text' },
      { key: 'pairedValue', label: 'Text on the other side' },
    ],
  },
};
