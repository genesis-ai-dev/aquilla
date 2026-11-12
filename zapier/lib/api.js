'use strict';

const { apiBase } = require('./config');
const { errorMessage, errorCode } = require('./middleware');

const url = (path) => `${apiBase()}${path}`;
const enc = encodeURIComponent;

// List routes answer `{ data, nextCursor }`. Accept `items` too, so a feed
// that ships with that name still works.
const rows = (body) => (body && (body.data || body.items)) || [];

const get = async (z, path, params) => {
  const response = await z.request({ url: url(path), params });
  return response.data;
};

const projectDetail = (z, projectId) => get(z, `/projects/${enc(projectId)}`);

// Every write goes through a changeset: stage it, then commit it. A connection
// approved in ask mode cannot commit on its own; the commit answers 428 and a
// person must approve the plan in Aquilla. That is the expected outcome of an
// ask-mode Zap, not a failure, so we return the approval link instead of
// throwing (a thrown error would make Zapier retry and eventually turn the Zap off).
const commitChangeset = async (z, projectId, staged) => {
  const changeset = staged.changeset || {};
  const base = {
    changesetId: changeset.id,
    summary: staged.summary || changeset.summary || null,
    approvalUrl: staged.approvalUrl || null,
  };
  const response = await z.request({
    url: url(`/projects/${enc(projectId)}/changesets/${enc(changeset.id)}/commit`),
    method: 'POST',
    skipThrowForStatus: true,
  });
  if (response.status === 428) {
    return { status: 'awaiting_approval', ...base };
  }
  if (response.status >= 400) {
    throw new z.errors.Error(errorMessage(response), errorCode(response), response.status);
  }
  const receipt = (response.data && response.data.receipt) || {};
  return {
    status: 'committed',
    ...base,
    appliedCount: receipt.appliedCount ?? null,
    staleCount: receipt.staleCount ?? null,
    committedAt: receipt.committedAt ?? null,
    eventIds: receipt.eventIds || [],
    warnings: receipt.warnings || [],
  };
};

const stageAndCommit = async (z, projectId, commands) => {
  const response = await z.request({
    url: url(`/projects/${enc(projectId)}/changesets`),
    method: 'POST',
    body: { commands },
  });
  return commitChangeset(z, projectId, response.data);
};

module.exports = { url, enc, rows, get, projectDetail, commitChangeset, stageAndCommit };
