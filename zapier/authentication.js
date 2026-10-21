'use strict';

const { identityBase, apiBase } = require('./lib/config');

// OAuth2 auth-code + PKCE against the Aquilla identity worker. Zapier is a
// confidential client: the token exchange also sends the client secret
// (client_secret_post). Tokens do not expire and there is no refresh token;
// a revoked token surfaces as a 401, which beforeRequest/afterResponse map to
// ExpiredAuthError so Zapier asks the user to reconnect.
const getAccessToken = async (z, bundle) => {
  const response = await z.request({
    url: `${identityBase()}/oauth/token`,
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: {
      grant_type: 'authorization_code',
      code: bundle.inputData.code,
      redirect_uri: bundle.inputData.redirect_uri,
      client_id: process.env.CLIENT_ID,
      client_secret: process.env.CLIENT_SECRET,
      code_verifier: bundle.inputData.code_verifier,
    },
  });
  return { access_token: response.data.access_token };
};

// /me proves the token works but carries no names, so look up the org name
// for the connection label ("Bible Translators Inc. (ask)").
const test = async (z) => {
  const me = (await z.request({ url: `${apiBase()}/me` })).data;
  const orgs = (await z.request({ url: `${apiBase()}/orgs` })).data;
  const list = (orgs && orgs.data) || [];
  const org = list.find((o) => o.id === me.orgId) || list[0];
  return { ...me, orgName: (org && org.name) || 'Aquilla' };
};

module.exports = {
  type: 'oauth2',
  oauth2Config: {
    authorizeUrl: {
      url: `${identityBase()}/oauth/authorize`,
      params: {
        client_id: '{{process.env.CLIENT_ID}}',
        state: '{{bundle.inputData.state}}',
        redirect_uri: '{{bundle.inputData.redirect_uri}}',
        response_type: 'code',
      },
    },
    getAccessToken,
    enablePkce: true,
    autoRefresh: false,
  },
  test,
  connectionLabel: '{{bundle.inputData.orgName}} ({{bundle.inputData.mode}})',
};
