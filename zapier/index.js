'use strict';

const { version } = require('./package.json');
const { version: platformVersion } = require('zapier-platform-core');

const authentication = require('./authentication');
const { addBearerHeader, handleErrors } = require('./lib/middleware');
const dropdowns = require('./triggers/dropdowns');
const activity = require('./triggers/activity');
const newProject = require('./triggers/new-project');
const changesetPending = require('./triggers/changeset-pending');
const addComment = require('./creates/add-comment');
const setTranslation = require('./creates/set-translation');
const draftCells = require('./creates/draft-cells');
const uploadFile = require('./creates/upload-file');
const findProject = require('./searches/find-project');
const findCell = require('./searches/find-cell');

const byKey = (list) => Object.fromEntries(list.map((item) => [item.key, item]));

module.exports = {
  version,
  platformVersion,
  authentication,
  // Pass inputs through as typed; the steps trim and default them themselves.
  flags: { cleanInputData: false },
  beforeRequest: [addBearerHeader],
  afterResponse: [handleErrors],
  triggers: byKey([
    ...Object.values(dropdowns),
    ...Object.values(activity),
    newProject,
    changesetPending,
  ]),
  creates: byKey([addComment, setTranslation, draftCells, uploadFile]),
  searches: byKey([findProject, findCell]),
};
