'use strict';

const { identityBase, syncBase } = require('./config');

const isAquillaUrl = (url) =>
  [syncBase(), identityBase()].some((base) => url === base || String(url).startsWith(`${base}/`));

// Only Aquilla requests carry the token. Upload & Import downloads the user's
// file from another host, and that host must never see it.
const addBearerHeader = (request, z, bundle) => {
  request.headers = request.headers || {};
  if (bundle.authData && bundle.authData.access_token && isAquillaUrl(request.url)) {
    request.headers.Authorization = `Bearer ${bundle.authData.access_token}`;
  }
  request.headers.accept = request.headers.accept || 'application/json';
  return request;
};

// The API's error envelope is `{ error: { code, message, details? } }`.
const errorBody = (response) => {
  const data = response.data;
  return data && typeof data === 'object' && data.error && typeof data.error === 'object'
    ? data.error
    : {};
};

const errorMessage = (response) =>
  String(errorBody(response).message || response.content || `HTTP ${response.status}`);

const errorCode = (response) => String(errorBody(response).code || 'error');

// A revoked or unknown token. The API answers 401, or 403 permission_denied
// "invalid or missing API credential" on some routes. Tokens never expire, so
// either one means the user revoked the grant in Aquilla.
const isDeadCredential = (response) =>
  response.status === 401 ||
  (response.status === 403 &&
    errorCode(response) === 'permission_denied' &&
    /credential/i.test(errorMessage(response)));

const handleErrors = (response, z) => {
  if (isDeadCredential(response)) {
    throw new z.errors.ExpiredAuthError(
      'Aquilla no longer accepts this connection. It may have been revoked in Preferences → API tokens. Reconnect your Aquilla account.',
    );
  }
  // Callers that handle a status themselves (the 428 on commit) opt out.
  if (response.skipThrowForStatus) return response;
  if (response.status >= 400) {
    throw new z.errors.Error(errorMessage(response), errorCode(response), response.status);
  }
  return response;
};

module.exports = { isAquillaUrl, addBearerHeader, handleErrors, errorMessage, errorCode };
