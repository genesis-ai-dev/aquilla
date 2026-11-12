'use strict';

// Shared input fields. The dropdowns read from the hidden triggers in
// triggers/dropdowns.js; File and Lane depend on the chosen project.

const orgField = {
  key: 'orgId',
  label: 'Organization',
  dynamic: 'org.id.name',
  helpText: 'Leave empty to include every organization you belong to.',
  altersDynamicFields: true,
};

const projectField = {
  key: 'projectId',
  label: 'Project',
  required: true,
  dynamic: 'project.id.name',
  altersDynamicFields: true,
};

const fileField = (required) => ({
  key: 'fileId',
  label: 'File',
  required,
  dynamic: 'file.id.name',
  helpText: required ? undefined : 'Leave empty to watch every file in the project.',
});

const laneField = (required, helpText) => ({
  key: 'laneId',
  label: 'Translation lane',
  required,
  dynamic: 'lane.id.name',
  helpText,
});

const cellField = {
  key: 'cellId',
  label: 'Cell',
  required: true,
  helpText:
    'The cell ID. Use the **Find Cell** search step to look it up by verse reference or text.',
};

module.exports = { orgField, projectField, fileField, laneField, cellField };
