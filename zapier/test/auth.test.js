'use strict';

const { App, appTester, nock, api, bundleWith, HOST, API } = require('./helpers');

afterEach(() => nock.cleanAll());

describe('authentication', () => {
  it('sends users to the identity worker with PKCE, because the token endpoint rejects codes without a verifier', () => {
    const { oauth2Config } = App.authentication;
    expect(App.authentication.type).toBe('oauth2');
    expect(oauth2Config.enablePkce).toBe(true);
    expect(oauth2Config.authorizeUrl.url).toBe(`${HOST}/identity/oauth/authorize`);
    expect(oauth2Config.authorizeUrl.params.client_id).toBe('{{process.env.CLIENT_ID}}');
    // No refresh token exists; a refresh attempt would only fail.
    expect(oauth2Config.autoRefresh).toBe(false);
    expect(oauth2Config.refreshAccessToken).toBeUndefined();
  });

  it('exchanges the code with the client secret and PKCE verifier (client_secret_post)', async () => {
    const scope = nock(HOST)
      .post('/identity/oauth/token', (body) =>
        body.grant_type === 'authorization_code' &&
        body.code === 'the-code' &&
        body.redirect_uri === 'https://zapier.com/dashboard/auth/oauth/return/App1CLIAPI/' &&
        body.client_id === 'test-client-id' &&
        body.client_secret === 'test-client-secret' &&
        body.code_verifier === 'the-verifier')
      .reply(200, { access_token: 'aqk_new', token_type: 'Bearer' });

    const result = await appTester(App.authentication.oauth2Config.getAccessToken, {
      inputData: {
        code: 'the-code',
        redirect_uri: 'https://zapier.com/dashboard/auth/oauth/return/App1CLIAPI/',
        code_verifier: 'the-verifier',
      },
    });

    expect(result).toEqual({ access_token: 'aqk_new' });
    scope.done();
  });

  it('tests the connection with /me and labels it with the org name and mode', async () => {
    const scope = api()
      .get(`${API}/me`)
      .reply(200, { mode: 'ask', access: 'write', orgId: 'org_2' })
      .get(`${API}/orgs`)
      .reply(200, { data: [{ id: 'org_1', name: 'Other' }, { id: 'org_2', name: 'Bible Translators Inc.' }], nextCursor: null });

    const result = await appTester(App.authentication.test, bundleWith());

    expect(result.orgName).toBe('Bible Translators Inc.');
    expect(result.mode).toBe('ask');
    expect(App.authentication.connectionLabel).toContain('{{bundle.inputData.orgName}}');
    scope.done();
  });

  it('asks the user to reconnect on 401, because tokens never expire and a 401 means the grant was revoked', async () => {
    api().get(`${API}/me`).reply(401, { error: { code: 'unauthorized', message: 'revoked' } });

    await expect(appTester(App.authentication.test, bundleWith())).rejects.toMatchObject({
      name: 'ExpiredAuthError',
    });
  });

  it('treats a 403 "invalid or missing API credential" as a dead connection too', async () => {
    api()
      .get(`${API}/me`)
      .reply(403, { error: { code: 'permission_denied', message: 'invalid or missing API credential' } });

    await expect(appTester(App.authentication.test, bundleWith())).rejects.toMatchObject({
      name: 'ExpiredAuthError',
    });
  });

  it('does not ask to reconnect for a role problem, because reconnecting would not fix it', async () => {
    api()
      .get(`${API}/me`)
      .reply(403, { error: { code: 'permission_denied', message: 'requires MAINTAINER' } });

    const err = await appTester(App.authentication.test, bundleWith()).catch((e) => e);
    expect(err.name).not.toBe('ExpiredAuthError');
    expect(err.message).toContain('requires MAINTAINER');
  });
});
