'use strict';

const { url, enc, commitChangeset } = require('../lib/api');
const { projectField, laneField } = require('../lib/fields');
const { resultSample, resultOutputFields, writeNote } = require('../lib/write-result');

const nameFromUrl = (fileUrl) => {
  try {
    return decodeURIComponent(new URL(fileUrl).pathname.split('/').pop() || '') || 'upload';
  } catch {
    return 'upload';
  }
};

// Upload the bytes as an artifact, have Aquilla parse it into a staged
// import changeset, then commit that changeset like any other write.
const perform = async (z, bundle) => {
  const { projectId, file, fileName, fileType, laneId } = bundle.inputData;
  const name = fileName || nameFromUrl(file);

  const download = await z.request({ url: file, raw: true });
  const bytes = await download.buffer();

  const uploaded = await z.request({
    url: url(`/projects/${enc(projectId)}/artifacts`),
    method: 'POST',
    headers: {
      'content-type': download.headers.get('content-type') || 'application/octet-stream',
      'x-artifact-name': name,
    },
    body: bytes,
  });
  const { artifactId } = uploaded.data;

  const parseBody = { stage: true, fileName: name };
  if (fileType) parseBody.fileType = fileType;
  if (laneId) parseBody.laneId = laneId;
  const staged = await z.request({
    url: url(`/projects/${enc(projectId)}/artifacts/${enc(artifactId)}/parse`),
    method: 'POST',
    body: parseBody,
  });

  const result = await commitChangeset(z, projectId, staged.data);
  return { ...result, artifactId, fileName: name };
};

module.exports = {
  key: 'upload_file',
  noun: 'File',
  display: {
    label: 'Upload & Import File',
    description: `Uploads a document (USFM, Word, subtitles and more) and imports it into a project. ${writeNote}`,
  },
  operation: {
    inputFields: [
      projectField,
      { key: 'file', label: 'File', required: true, type: 'file', helpText: 'Up to 25 MB.' },
      {
        key: 'fileName',
        label: 'File name',
        helpText: 'Optional. Defaults to the name of the uploaded file. Aquilla uses the extension to detect the format.',
      },
      {
        key: 'fileType',
        label: 'Format',
        helpText:
          'Optional. Aquilla detects the format from the file. Set it for formats it cannot detect, such as po, properties, obs or sbv.',
      },
      laneField(false, 'Optional. The lane to import into.'),
    ],
    perform,
    sample: { ...resultSample, summary: 'Import MRK.usfm (678 cells)', artifactId: 'art_123', fileName: 'MRK.usfm' },
    outputFields: [
      ...resultOutputFields,
      { key: 'artifactId', label: 'Uploaded artifact ID' },
      { key: 'fileName', label: 'File name' },
    ],
  },
};
