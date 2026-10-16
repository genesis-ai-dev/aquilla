'use strict';

const { stageAndCommit } = require('../lib/api');
const { projectField, fileField, laneField, cellField } = require('../lib/fields');
const { resultSample, resultOutputFields, writeNote } = require('../lib/write-result');

const perform = (z, bundle) => {
  const { projectId, fileId, cellId, laneId, value } = bundle.inputData;
  return stageAndCommit(z, projectId, [{ kind: 'SetTranslation', fileId, cellId, laneId, value }]);
};

module.exports = {
  key: 'set_translation',
  noun: 'Translation',
  display: {
    label: 'Set Translation',
    description: `Saves translated text for one cell. ${writeNote}`,
  },
  operation: {
    inputFields: [
      projectField,
      fileField(true),
      cellField,
      laneField(true, 'The language the translation is in.'),
      { key: 'value', label: 'Translation', required: true, type: 'text' },
    ],
    perform,
    sample: { ...resultSample, summary: 'Set translation for 1 cell' },
    outputFields: resultOutputFields,
  },
};
