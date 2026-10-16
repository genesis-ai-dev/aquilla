'use strict';

const { activityTrigger } = require('../lib/activity');

const newComment = activityTrigger({
  key: 'new_comment',
  noun: 'Comment',
  label: 'New Comment',
  description: 'Triggers when someone comments on a cell in a project.',
  kinds: ['comment.create'],
  sample: { kind: 'comment.create', data: { commentId: 'cmt_1', body: 'Should this be "teacher" here?', parentCommentId: null } },
  outputFields: [
    { key: 'data__commentId', label: 'Comment ID' },
    { key: 'data__body', label: 'Comment text' },
    { key: 'data__parentCommentId', label: 'Reply to comment ID' },
  ],
});

const cellTranslated = activityTrigger({
  key: 'cell_translated',
  noun: 'Translation',
  label: 'Cell Translated',
  description: 'Triggers when a translation is saved for a cell.',
  kinds: ['target.cell.commit'],
  sample: { kind: 'target.cell.commit', data: { laneId: 'lan_123', value: 'Dispela em i stat bilong gutnius bilong Jisas Krais.' } },
  outputFields: [
    { key: 'data__laneId', label: 'Lane ID' },
    { key: 'data__value', label: 'Translation text' },
  ],
});

const cellValidated = activityTrigger({
  key: 'cell_validated',
  noun: 'Validation',
  label: 'Cell Validated',
  description: 'Triggers when someone marks a cell translation as checked.',
  kinds: ['cell.validate'],
  sample: { kind: 'cell.validate', data: { laneId: 'lan_123' } },
  outputFields: [{ key: 'data__laneId', label: 'Lane ID' }],
});

const newFile = activityTrigger({
  key: 'new_file',
  noun: 'File',
  label: 'New File',
  description: 'Triggers when a file is added to a project.',
  kinds: ['file.create'],
  sample: { kind: 'file.create', cellId: null, data: { name: 'MRK.usfm' } },
  outputFields: [{ key: 'data__name', label: 'File name' }],
});

// Event kinds people are most likely to want.
const KIND_CHOICES = [
  { value: 'comment.create', label: 'Comment added' },
  { value: 'comment.resolve', label: 'Comment resolved' },
  { value: 'comment.edit', label: 'Comment edited' },
  { value: 'target.cell.commit', label: 'Translation saved' },
  { value: 'cell.validate', label: 'Cell checked' },
  { value: 'cell.unvalidate', label: 'Cell check removed' },
  { value: 'source.cell.commit', label: 'Source text changed' },
  { value: 'file.create', label: 'File added' },
  { value: 'file.rename', label: 'File renamed' },
  { value: 'file.delete', label: 'File deleted' },
  { value: 'cell.audio.attach', label: 'Audio attached' },
];

const projectActivity = activityTrigger({
  key: 'project_activity',
  noun: 'Activity',
  label: 'New Project Activity',
  description: 'Triggers when a kind of change you choose happens in a project.',
  kinds: null,
  extraInputFields: [
    {
      key: 'kinds',
      label: 'What to watch',
      required: true,
      list: true,
      choices: KIND_CHOICES.map((c) => ({ ...c, sample: c.value })),
      helpText: 'Pick one or more kinds of change.',
    },
  ],
  sample: { kind: 'comment.resolve', data: {} },
});

module.exports = { newComment, cellTranslated, cellValidated, newFile, projectActivity };
