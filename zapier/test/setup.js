'use strict';

// Fake endpoints and credentials. nock intercepts every request, so nothing
// leaves the machine.
process.env.CLIENT_ID = 'test-client-id';
process.env.CLIENT_SECRET = 'test-client-secret';
process.env.IDENTITY_BASE = 'https://api.test.aquilla.app/identity';
process.env.SYNC_BASE = 'https://api.test.aquilla.app/sync';
