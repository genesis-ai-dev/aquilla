'use strict';

const { stageAndCommit } = require('../lib/api');
const { projectField, fileField, laneField } = require('../lib/fields');
const { resultSample, resultOutputFields, writeNote } = require('../lib/write-result');

const perform = (z, bundle) => {
  const { projectId, fileId, laneId, instructions } = bundle.inputData;
  const cellIds = [].concat(bundle.inputData.cellIds || []).filter(Boolean);
  const command = { kind: 'DraftCells', fileId, cellIds, laneId };
  if (instructions) command.instructions = instructions;
  return stageAndCommit(z, projectId, [command]);
};

module.exports = {
  key: 'draft_cells',
  noun: 'Draft',
  display: {
    label: 'AI-Draft Cells',
    description: `Asks Aquilla's AI to draft translations for some cells. ${writeNote}`,
  },
  operation: {
    inputFields: [
      projectField,
      fileField(true),
      {
        key: 'cellIds',
        label: 'Cells',
        required: true,
        list: true,
        helpText:
          'The cell IDs to draft, up to the project batch size (10 unless your project sets more, never above 50). Use **Find Cell** to look them up.',
      },
      laneField(true, 'The language to draft into.'),
      {
        key: 'instructions',
        label: 'Extra instructions',
        type: 'text',
        helpText: 'Optional guidance for the AI, up to 2,000 characters.',
      },
    ],
    perform,
    sample: { ...resultSample, summary: 'Draft 3 cells' },
    outputFields: resultOutputFields,
  },
};
