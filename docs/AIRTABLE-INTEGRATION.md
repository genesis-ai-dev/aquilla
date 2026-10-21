# Airtable integration

Pushes each project's progress into an Airtable table. Built in AQU-804 for
Come & See, in the same shape as the Monday integration
([MONDAY-INTEGRATION.md](MONDAY-INTEGRATION.md)): the same tables, the same
metrics, the same push triggers and most of the same settings screens. This is
the short contract the code comments point at; the code is the detail.

## Shape

- **One connection per org.** An org owner or maintainer pastes an Airtable
  personal access token in Org settings → Airtable
  (`/orgs/:orgId/settings/airtable`), or in the setup's connect step. The
  server checks it with Airtable (`GET /v0/meta/whoami`, then
  `GET /v0/meta/bases`, which needs `schema.bases:read`) and stores it
  AES-GCM encrypted in `integration_connections` (`provider = 'airtable'`):
  `lib/integrations/token-crypto.ts`, key context `:airtable-token`, key
  material `MONDAY_TOKEN_KEY` when set, else `SECRET_KEY` (the same secret
  covers both providers). It never reaches the browser. A personal access
  token doesn't expire, so there is no refresh; a 401 from Airtable sets
  `needs_reauth` and the settings page asks for a new token.
- **One table link per project.** `integration_links` with
  `external_id` = base id (`app…`), `external_name` = table name,
  `config` = `AirtableMapping` (below), `remote_state` = the table's fields as
  last read. There are no webhooks: the settings page re-reads the table when
  it loads the link (`table-changes`).
- **Records.** `integration_item_links` remembers each entity's record id.

Environments work as Monday's (AQU-1775): the row is stamped with the
deployment that stored it, and `getAirtableToken` refuses another
deployment's row before decrypting. `pnpm neon:scrub:dev` deletes every
provider's connections.

## Mapping (`AirtableMapping`)

Defined twice, kept in lockstep: `auth-worker/src/lib/airtable/types.ts` and
`src/lib/airtable/types.ts`. It is Monday's mapping in Airtable's words: a
column is a field (`columnId` = field id, `columnType` = field type), an item
is a record, and the metrics are Monday's, from the same
`computeProjectMetrics`.

- `tableId`: the table (`tbl…`).
- `itemGranularity`: `project` (one record), `file` (one record per file —
  an episode for Come & See), or `project_and_files` (both, in this table).
- `columns`: field id → metric. Writable field types per metric are in
  `WRITABLE_FIELD_TYPES_BY_METRIC`; computed fields (formula, rollup, lookup,
  count, autoNumber, created/modified) are never written.
- Values: a percentage into a `percent` field is a fraction (51.7% → 0.517),
  into a `number` field the number; dates are `YYYY-MM-DD`; Status and
  Schedule are single-select labels (`typecast` adds a missing choice); an
  empty value clears the cell.
- The server always maps two fields when the table has them, whatever was
  proposed: an "Aquilla ID" text field (`external_id`, and `matchExisting`
  merges on it) and the table's primary field (`project_name`, the record's
  name) when it is a text field nothing else writes.
- Names (Translators, Project manager) are opt-in, exactly as on Monday: not
  ticked unless the table already has them.

## Pushes

`lib/airtable/push.ts`. With an Aquilla ID field every push is an upsert
(`PATCH` with `performUpsert.fieldsToMergeOn`), so a record someone deleted is
made again and nothing is doubled. Without one, remembered records are checked
against the table, updated in place, and missing ones created (or adopted by
name with `matchExisting: { byName: true }`).

Airtable's limits, in `lib/airtable/client.ts`: at most 10 records per create
or update request; at most 5 requests a second per base (requests to a base
are spaced 220 ms apart within an isolate); a 429 is waited out (Retry-After,
else Airtable's 30 seconds) and retried once, after which the push counts as a
transient failure and the AQU-1828 backoff retries it. A field the table no
longer accepts is left out of a second attempt, reported on the link, and
raises "The table's fields changed".

Every Monday trigger pushes Airtable links too (`lib/integrations/push.ts`,
`db/shared/progress-sync-dirty.ts`): the sync-worker's edit nudge
(`/api/v2/monday/internal/push`, which now schedules every provider's links),
the 5-minute cron flush, settings that change the numbers, languages added,
renamed or archived, the deadline, the project manager and plan changes.

## Routes (identity worker, `/api/v2/airtable`)

Listed at the top of `auth-worker/src/routes/airtable.ts`. Org routes need an
org maintainer, except reading the connection status (any member). Project
routes need a project maintainer, except reading the link (any member).

- `PUT /orgs/:orgId/connection { token }` answers the connection status (and
  `baseCount`), or 400 with `reason`: `token_rejected` or `missing_scopes`
  (`missingScopes`); 502 `airtable_unreachable`.
- `POST /projects/:projectId/analyze { baseId?, tableId?, message?, currentConfig? }`:
  without a table, reads the tables of the token's first 10 bases and lets the
  AI pick one. Answers the clamped `proposal`, `warnings`, `tableReason` and
  the table's `structure`; 409 `noTables` when the token sees none.
- `POST /projects/:projectId/fields { baseId, tableId, metrics }` creates the
  missing fields with Monday's column titles and Airtable's types, reuses one
  already there by name, and always adds Aquilla ID. Needs
  `schema.bases:write`; without it each field comes back in `failed`.
- `GET /projects/:projectId/table-changes`, `POST …/table-changes/dismiss { fieldIds }`:
  Monday's board changes for the table.

## Testing it live

No Airtable app or secret is needed on any deployment. To walk it against a
real account:

1. In Airtable, make a base with a table to push into (any fields; an empty
   table works, because setup adds what's missing). For Come & See's shape, a
   table whose primary field is a text "Name" and, optionally, a percent
   "Progress" and a single-select "Status".
2. Create a personal access token at <https://airtable.com/create/tokens> with
   the scopes `data.records:read`, `data.records:write`, `schema.bases:read`
   and `schema.bases:write`, and give it access to that base.
3. In Aquilla, Org settings → Airtable, paste the token. Then Project settings
   → Integrations → Airtable → Set up with AI.

For a local stack without an account, `AIRTABLE_API_URL` in
`auth-worker/.dev.vars` points the worker at a stand-in Airtable (the test
suite's `src/__tests__/helpers/fake-airtable.ts` answers Airtable's shapes).
Leave it unset everywhere else.
