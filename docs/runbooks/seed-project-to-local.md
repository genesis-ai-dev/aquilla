# Seed a project into a developer's local database

How to hand a developer a copy of one Aquilla project for their local Postgres
**without giving them Neon, R2 or Cloudflare access**. One person with
credentials extracts; the developer only loads. (AQU-1953.)

Why not share the Neon console: Neon permissions are per *project*, and `dev`
and `production` are two branches of the same Neon project, so any console
access that can run SQL can read production. See
[DEPLOYMENT-ENVIRONMENTS.md](../DEPLOYMENT-ENVIRONMENTS.md) for the branch
matrix and [OPSEC.md](../OPSEC.md) §1 for what the database holds.

Design background: [2026-06-06-dev-db-seed-design.md](../superpowers/specs/2026-06-06-dev-db-seed-design.md).
Table list: `scripts/lib/seed-tables.ts`, checked against `db/postgres/schema.sql`
by `scripts/lib/seed-tables.test.ts`.

## What the developer receives

- The project rows and everything project-scoped that the app reads: files,
  cells and their event history, validators and waivers, comments, audio
  metadata and votes, back-translations, assignments, checkpoints, lanes and
  lane grants, and the dashboard's progress rollups.
- Identities are scrubbed deterministically: every user becomes
  `user_<id>` / `user_<id>@example.test` / "User <id>", with no password hash,
  avatar or preferences. Password-reset tokens, invite tokens and activity logs
  are never extracted. Author tokens that match no user pass through unscrubbed;
  the extract prints a warning listing them — read it.
- **Not** included: anything in R2. Audio takes will not play, "download
  original" fails, checkpoint blobs are missing. Org settings (vendor API keys),
  agent artifacts and contextual-AI runs are not copied either.
- The translation text itself is real and unpublished (OPSEC D2). Treat the
  bundle like the project: share it through something with access control, not
  chat, and delete it when the work is done.

## Maintainer: extract

Prerequisites: a checkout at the same `db/postgres/schema.sql` the developer
will load into, and Postgres access to the source branch. `scripts/neon-target.ts`
resolves that access from `NEON_DEV_PG_*` / `NEON_PG_*` in your environment or,
failing that, from a logged-in Neon CLI (`npx neon@2.30.0 auth`, the version the repo pins).

1. Pick the source. The `dev` branch is normally a restore of production, so
   prefer it; nothing then touches the production endpoint.
2. Put the project id(s) in `projectIds` of `db/seed/manifest.json`. For a
   one-off hand-off this edit is temporary; for a project that should be in the
   standard seed everyone loads, it is permanent (see "Standard seed" below).
3. Extract without uploading:

```bash
pnpm seed:extract:dev --no-upload
```

   (`pnpm seed:extract:prod --no-upload` reads the production branch.) This
   writes `db/seed/.cache/dev-seed-<sha>.jsonl.zst` and rewrites
   `db/seed/seed.meta.json` with the bundle's sha256, the schema hash, and
   `source: "neon dev"`.
4. Send the developer **both** files: the bundle from `db/seed/.cache/` and
   `db/seed/seed.meta.json`.
5. Put the repo back:

```bash
git checkout -- db/seed/manifest.json db/seed/seed.meta.json
```

### Standard seed (shared, in R2)

To change the bundle that `pnpm seed:dev` fetches for everyone, edit the
manifest for real and run `pnpm seed:extract:dev` **without** `--no-upload`.
That needs `wrangler` logged in with R2 write on the account. Commit
`db/seed/manifest.json` and `db/seed/seed.meta.json`; the bundle itself is
content-addressed in R2 and never committed.

## Developer: load

Prerequisites: Docker, `pnpm i`, and `pnpm dev` run at least once so that the
`aquilla-dev-pg` container exists with the current schema and the local `dev`
user has been created (sign in once at `http://localhost:5173`). Your checkout
must have the same `db/postgres/schema.sql` the bundle was extracted against.

1. Place the files. The bundle goes in `db/seed/.cache/` under the exact file
   name you were given (the loader looks for the basename of `r2.key` in the
   meta); the meta replaces `db/seed/seed.meta.json`. Do not commit either; the
   cache directory is git-ignored, the meta is not.
2. Load:

```bash
pnpm seed:load --local --grant-to dev
```

   `--grant-to dev` makes your local `dev` user an Owner of every seeded org and
   project, which is what makes them visible and also clears the lane
   read-wall (Maintainer and above are not lane-gated). Skip it if you want to
   test as a lower role; then add yourself through the app's member UI.
3. Open `http://localhost:5173`. The project is under its seeded org.

The load is idempotent: it deletes the seeded ids and re-inserts, inside one
transaction, and verifies row counts afterwards. Loading again after local
edits replaces them.

### Standard seed instead of a hand-off

If the project is in the committed manifest, no files need to change hands:

```bash
pnpm seed:dev -- --grant-to dev
```

`seed:dev` fetches the bundle named in the committed meta with
`wrangler r2 object get`, which needs a Cloudflare login with R2 read on the
account. A hand-off of the two files avoids that requirement entirely.

## When it refuses

- **`schema.sql hash … != bundle … (schema drift)`** — the bundle was
  extracted at a different schema than your checkout. Best fix: re-extract at
  the same commit. If you know the only drift is in tables the seed does not
  carry, `--ignore-schema-hash` skips the hash but the loader still refuses a
  target that lacks any column the bundle has.
- **`target schema is stale — missing column(s)`** — your local Postgres is
  behind `schema.sql`. Restart `pnpm dev` first: on boot it adds any table or
  column `schema.sql` has that the container lacks. If the drift is a changed
  shape rather than a missing one, recreate the container:

```bash
docker rm -f aquilla-dev-pg
```

  then `pnpm dev` again, which creates the container and applies the schema.
- **`no user "dev" in target`** — boot the app and sign in once before loading
  with `--grant-to dev`.
- **A foreign-key error at `DELETE FROM users` / `organizations` on a second
  load** — you created org- or user-level rows locally that point at a seeded
  org or user (billing cohorts, platform settings, usage requests by a seeded
  user). Project-scoped leftovers are cleared automatically; these are not.
  Recreate the local Postgres as above.

## Limits

- One bundle, one meta. The loader reads `db/seed/seed.meta.json`; two
  hand-offs cannot be loaded side by side without swapping the meta.
- No R2 content, so nothing audio-related is exercisable locally from a seed.
- Remote targets: `pnpm seed:load --target "<url>" --confirm-remote-target <host>`
  loads into another Postgres. A host declared production (`NEON_PG_HOST`,
  `AQUILLA_PROD_PG_HOST`) is refused outright; the loader deletes before it
  inserts (AQU-750). **Do not point it at the shared Neon `dev` branch for an
  org that has real accounts:** the load deletes and re-inserts every user in
  the seeded projects' org and group closure as scrubbed `user_<id>` rows with
  no password, which signs those people out of dev.aquilla.app for good. The
  seed is for throwaway databases.
