'use strict';

// Base URLs come from env so the same build runs against dev or prod.
// Set them with `zapier env:set <version> IDENTITY_BASE=... SYNC_BASE=...`.
const DEFAULT_IDENTITY_BASE = 'https://api.aquilla.app/identity';
const DEFAULT_SYNC_BASE = 'https://api.aquilla.app/sync';

const trimSlash = (url) => url.replace(/\/+$/, '');

const identityBase = () =>
  trimSlash(process.env.IDENTITY_BASE || DEFAULT_IDENTITY_BASE);
const syncBase = () => trimSlash(process.env.SYNC_BASE || DEFAULT_SYNC_BASE);
const apiBase = () => `${syncBase()}/api/v1/external`;

module.exports = { identityBase, syncBase, apiBase };
