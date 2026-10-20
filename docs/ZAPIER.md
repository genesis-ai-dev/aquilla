# Aquilla on Zapier

Aquilla's public Zapier integration lets people start Zaps from project
activity and write back into Aquilla. It is built on three pieces:

- **The Zapier app**: the `zapier/` package, built with the Zapier Platform CLI.
- **The external REST Agent API**: sync-worker `/api/v1/external/*`. Every
  Zapier call goes here. Zapier never uses MCP.
- **OAuth on the identity worker**: `auth-worker/src/routes/mcp-oauth.ts`,
  shared with the ChatGPT plugin (`docs/CHATGPT-PLUGIN.md`). Zapier connects
  to it as a pre-registered confidential client.

## Sign-in

Zapier uses OAuth 2.1 with an authorization code, PKCE and a client secret. A
Zapier integration version supports only one auth type, so the public app uses
OAuth only. Personal API tokens keep working for the direct API, for MCP, and
for "Webhooks by Zapier" steps.

| Step | Where |
| --- | --- |
| Zapier sends the user to `/identity/oauth/authorize` | `mcp-oauth.ts`, which redirects to the SPA `/oauth/consent` |
| Consent: choose organizations, access (read or write) and mode (ask or act) | `src/pages/OAuthConsent.tsx`. The choices appear only for a pre-registered client (`scopeChoices`). |
| Zapier exchanges the code at `/identity/oauth/token` with `client_secret` and the PKCE verifier | `mcp-oauth.ts` |
| The result is an `aqk_` API credential named "Zapier" | `api_credentials` |

How Zapier differs from the MCP hosts:

- **Identity is configuration, not a fetched document.** `ZAPIER_CLIENT_ID`,
  `ZAPIER_REDIRECT_URI` and the secret `ZAPIER_CLIENT_SECRET` are set on
  auth-worker (`lib/mcp-oauth/static-clients.ts`). If any of the three is
  unset, that environment has no Zapier client.
- **The secret is required.** A code minted for the REST audience is redeemed
  only with the matching secret, sent as `client_secret_post` or
  `client_secret_basic` and compared in constant time. A wrong secret gets
  `401 invalid_client`, and the code is not consumed.
- **The token is REST-only.** It is bound to the audience
  `${SYNC_WORKER_URL}/api/v1/external`. REST routes accept only that audience
  (`validateApiCredentialRequest` in `db/shared/api-credentials.ts`), and MCP
  rejects it. MCP tokens stay MCP-only. Personal tokens have no audience and
  work on both.
- **The human chooses the scope.** The default is ask mode with read and
  write access. Ask mode stages each write as a changeset that a person
  approves, so Zapier actions return `awaiting_approval` with an
  `approvalUrl`. Act mode applies writes immediately.
- **The organization floor is unchanged.** Only organizations where the user
  is a maintainer or above appear on the consent page, the same as ChatGPT.
  This means contributors cannot connect Zapier yet.
- **Tokens have no expiry and no refresh token.** The connection works until
  the user revokes it in Preferences → API tokens. The list labels it as a
  "connected app", and the user's live role is checked on every call.
- **Collaborator identity is withheld** (`pii` is off), so feeds show
  pseudonymous authors.

## Triggers and actions

The Zapier app (`zapier/`) polls:

- `GET /projects/:pid/activity?kinds=`, newest first. This feeds New Comment,
  Cell Translated, Cell Validated, New File and the generic New Project
  Activity trigger.
- `GET /projects?sort=created` for New Project.
- `GET /projects/:pid/changesets/pending` for Changeset Needs Approval.

The app writes through changesets: Add Comment (EmitEvents `comment.create`),
Set Translation, AI-Draft Cells (DraftCells), and Upload & Import File
(artifact upload → parse `{stage:true}` → commit). See `zapier/README.md` for
field-level detail.

## Environments and setup (one time per environment)

The CLI is `zapier-platform-cli`. Since v19 its command is `zapier-platform`;
older docs and most web examples say `zapier`. `zapier-sdk` is a different
tool, used for calling other apps from code, and cannot publish an
integration. The app's base URLs default to production (`zapier/lib/config.js`),
so the production version needs no `IDENTITY_BASE`/`SYNC_BASE`.

1. In `zapier/`, run `zapier-platform login`, then `zapier-platform register
   "Aquilla"`. Pass `--desc` (40–140 characters, starting "Aquilla is a…", with
   no "Zapier" and no links), `--url https://aquilla.app` (the marketing site,
   not the app's login page), `--audience private`, and `--category`.
   `register` writes `zapier/.zapierapprc` (the App ID).
2. Run `zapier-platform describe` and copy the OAuth **redirect URI** from it. It
   is usually `https://zapier.com/dashboard/auth/oauth/return/App<ID>CLIAPI/`,
   but take the value `describe` prints.
3. Generate a client id and a long random secret. Then:
   - On auth-worker, for each environment: set `ZAPIER_CLIENT_ID` and
     `ZAPIER_REDIRECT_URI` as vars, and run
     `wrangler secret put ZAPIER_CLIENT_SECRET --env <env>`.
   - Run `zapier-platform push`, then
     `zapier-platform env:set <version> CLIENT_ID=… CLIENT_SECRET=…`.
4. Apply migration `0180_mcp_oauth_codes_access.sql`. Production has had it
   since 2026-10-19.

**Production state (2026-10-19).** Registered as integration **App248170**
(`zapier/.zapierapprc`). Version 1.0.0 is pushed, private. Redirect URI:
`https://zapier.com/dashboard/auth/oauth/return/App248170CLIAPI/` (from
`describe`). Client id `aquilla-zapier`. The production auth-worker has
`ZAPIER_CLIENT_ID`, `ZAPIER_REDIRECT_URI` and `ZAPIER_CLIENT_SECRET`, all as
wrangler secrets. Read the secret back with `zapier-platform env:get 1.0.0`
when a new version needs it. Dev has no Zapier client.

**Deploy order: migrate first.** The identity worker's consent decision and
token endpoint read and write `mcp_oauth_codes.access`, which only `0180`
adds. That holds for every OAuth client, ChatGPT and Claude included, not
only Zapier. Apply `0180` to an environment's database before deploying this
auth-worker there, or MCP-host connections fail too. The migration is
additive (a defaulted column), so applying it early is safe for the old code.
The `schema-guard` job in `deploy-workers.yml` already refuses to publish while
a migration is unapplied, so the failure mode is a blocked deploy, not a live
outage — apply it with `npm run neon:apply` and re-run.

## Public listing checklist

From Zapier's publishing requirements and integration-checks reference
(docs.zapier.com/platform/publish/integration-publishing-requirements and
.../integration-checks-reference, checked 2026-10-19). `zapier-platform validate`
runs the same checks. Errors and publishing tasks block a submission; warnings
do not.

Account and listing:
- [ ] A Zapier team admin has an email at the homepage's domain (an
  `@aquilla.app` address, added with `zapier-platform team`). Check M005
  compares that admin's email domain with the homepage URL, so
  `admin@frontierrnd.com` alone may fail it.
- [ ] Homepage URL `https://aquilla.app`, with the API docs linked in the submission
- [ ] Logo: square, transparent PNG, at least 512×512 px, no text
- [ ] Description (40–140 characters, "Aquilla is a…"), category, intended audience and role, set in the Platform UI's branding settings
- [ ] Aquilla is publicly available with self-serve sign-up. Zapier will not list an invite-only or "beta" product.

Reviewer access:
- [ ] A production account on `integration-testing@zapier.com`. It must not expire, Zapier must be able to change its password, every feature the integration uses must be on (including AI drafting credits), with no trial limits and no super-admin access. Give it an org where it is a maintainer, so the consent page lists the org.

Usage before submitting (checks S001, S002 and T001):
- [ ] At least **3 users** with a live Zap on the integration. Invite testers with `zapier-platform users add <email> <version>`.
- [ ] **Every** visible trigger, action and search is in a live Zap with at least one successful run: 7 triggers, 4 actions, 2 searches. Don't delete those Zaps or their history.
- [ ] Live results match the sample data and output fields (T004, T005). Re-run `zapier-platform validate` once the Zaps have history.

Our own pages (Zapier does not require these; we want them live first):
- [ ] Privacy §6 "Integrations you connect" and terms §8 "Third-party integrations" live on aquilla.app (aquilla-marketing)
- [ ] Help page at help.aquilla.app/automation/zapier/ (aquilla-help). It is unlisted until launch; list it when the app goes public.

Submitting:
- [ ] In the Platform UI: **Publish**, fill in the form, then **Submit for Review**. No CLI command submits. Zapier replies within about a week. An approved app is listed with a Beta tag for 90 days, then becomes Public. A signup through an embedded Zapier element in the product ends Beta early.
