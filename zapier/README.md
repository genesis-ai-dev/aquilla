# Aquilla for Zapier

The public Zapier integration for Aquilla, built on
[`zapier-platform-core`](https://github.com/zapier/zapier-platform). It talks to the
Agent API (`sync-worker` `/api/v1/external/*`) with an OAuth token from the identity
worker (`auth-worker` `/oauth/*`).

This is its own package, like the workers. The root `pnpm test` and `pnpm lint` skip it.

```bash
cd zapier
npm ci
npm test            # jest + nock, no network
npm run validate    # zapier-platform validate: schema + publishing checks
```

## What it does

| Kind | Name | API call |
| --- | --- | --- |
| Auth | OAuth2 (auth code + PKCE + client secret) | `GET /me` as the connection test |
| Trigger | New Comment, Cell Translated, Cell Validated, New File, New Project Activity | `GET /projects/:pid/activity?kinds=` |
| Trigger | New Project | `GET /projects?sort=created` |
| Trigger | Changeset Needs Approval | `GET /projects/:pid/changesets/pending` |
| Hidden trigger | Organization, Project, File, Lane dropdowns | list routes |
| Action | Add Comment, Set Translation, AI-Draft Cells | stage a changeset, then commit it |
| Action | Upload & Import File | upload an artifact, parse it with `stage:true`, then commit |
| Search | Find Project, Find Cell | `GET /projects`, `GET /projects/:pid/search` |

Every action stages a changeset and then commits it. If the connection was approved
in **ask** mode, the commit answers `428`. The action then returns
`{ status: "awaiting_approval", approvalUrl }` instead of failing, because a human
approval is the expected next step, not an error.

## Environment

| Variable | Purpose | Dev | Prod |
| --- | --- | --- | --- |
| `IDENTITY_BASE` | identity worker base | `https://api.dev.aquilla.app/identity` | `https://api.aquilla.app/identity` (default) |
| `SYNC_BASE` | sync worker base | `https://api.dev.aquilla.app/sync` | `https://api.aquilla.app/sync` (default) |
| `CLIENT_ID` | OAuth client id the identity worker knows as Zapier (`ZAPIER_CLIENT_ID`) | | |
| `CLIENT_SECRET` | the matching `ZAPIER_CLIENT_SECRET` | | |

For local tests, copy `.env.example` to `.env`. The tests use fake values and nock, so
they need no real secrets.

## First-time setup (Ryder only)

1. Install the Platform CLI. This is **not** `zapier-sdk`; that tool calls other apps
   from code and cannot build or publish an integration.

   ```bash
   npm i -g zapier-platform-cli
   ```

   Version 19 installs the command as `zapier-platform`. Older guides call it `zapier`.
   It is also a dev dependency here, so `npx zapier-platform ...` works without the global install.

2. Log in to Zapier.

   ```bash
   zapier-platform login
   ```

3. Register the integration from this folder. This writes `.zapierapprc` with the App ID.

   ```bash
   zapier-platform register "Aquilla"
   ```

4. Give the redirect URI to the identity worker. It is fixed by the App ID:
   `https://zapier.com/dashboard/auth/oauth/return/App<ID>CLIAPI/`. Set it as
   `ZAPIER_REDIRECT_URI` on auth-worker (dev and prod), together with
   `ZAPIER_CLIENT_ID` and the `ZAPIER_CLIENT_SECRET` secret.

5. Push the first version, then set its environment.

   ```bash
   zapier-platform push
   ```

   ```bash
   zapier-platform env:set 1.0.0 CLIENT_ID=<id> CLIENT_SECRET=<secret>
   ```

   ```bash
   zapier-platform env:set 1.0.0 IDENTITY_BASE=https://api.dev.aquilla.app/identity SYNC_BASE=https://api.dev.aquilla.app/sync
   ```

   Leave out the last command to point the version at production.

6. Connect an account in the Zapier editor and try one Zap per trigger and action.

## Releasing a new version

1. Bump `version` in `package.json`.
2. Run `npm test` and `npm run validate`.
3. Push it, copy the env vars, then promote it once it works.

   ```bash
   zapier-platform push
   ```

   ```bash
   zapier-platform env:set <new-version> CLIENT_ID=<id> CLIENT_SECRET=<secret>
   ```

   ```bash
   zapier-platform promote <new-version>
   ```

4. Move existing users with `zapier-platform migrate <old-version> <new-version>`.

Public listing needs a 256px logo, a reviewer test account on prod, and live privacy,
terms and help URLs.

## Known gaps

- The activity feed (`/projects/:pid/activity`), `/changesets/pending` and `sort=created`
  are being added to sync-worker in parallel. The fixtures follow the planned shapes
  (`{ data | items, nextCursor }`, items `{ id, kind, fileId, cellId, serverSeq, serverTs, author, data }`).
  Check them against the merged routes before the first push.
- Cell fields take a typed cell ID (validate warns D004). There is no cell dropdown,
  because files can hold thousands of cells. Use **Find Cell** to fill them.
