'use strict';

const { stageAndCommit } = require('../lib/api');
const { projectField, fileField, cellField } = require('../lib/fields');
const { resultSample, resultOutputFields, writeNote } = require('../lib/write-result');

const perform = (z, bundle) => {
  const { projectId, fileId, cellId, body, parentCommentId } = bundle.inputData;
  const payload = { body };
  if (parentCommentId) payload.parentCommentId = parentCommentId;
  return stageAndCommit(z, projectId, [
    { kind: 'EmitEvents', events: [{ kind: 'comment.create', fileId, cellId, payload }] },
  ]);
};

module.exports = {
  key: 'add_comment',
  noun: 'Comment',
  display: {
    label: 'Add Comment',
    description: `Adds a comment to a cell. ${writeNote}`,
  },
  operation: {
    inputFields: [
      projectField,
      fileField(true),
      cellField,
      { key: 'body', label: 'Comment', required: true, type: 'text' },
      {
        key: 'parentCommentId',
        label: 'Reply to comment ID',
        helpText: 'Optional. Fill this in to post a reply to an existing comment.',
      },
    ],
    perform,
    sample: resultSample,
    outputFields: resultOutputFields,
  },
};
