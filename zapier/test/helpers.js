'use strict';

const nock = require('nock');
const zapier = require('zapier-platform-core');
const App = require('../index');

const appTester = zapier.createAppTester(App);
const HOST = 'https://api.test.aquilla.app';
const API = '/sync/api/v1/external';
const TOKEN = 'aqk_test_token';

const bundleWith = (inputData = {}) => ({ authData: { access_token: TOKEN }, inputData });

// Every Aquilla call must carry the connection's token.
const api = () => nock(HOST, { reqheaders: { authorization: `Bearer ${TOKEN}` } });

module.exports = { App, appTester, nock, api, bundleWith, HOST, API, TOKEN };
