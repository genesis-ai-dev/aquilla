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

1. Run `npm i -g zapier-platform-cli`, `zapier login`, then
   `zapier register "Aquilla"` in `zapier/`. Note: `zapier-sdk` is a
   different tool, used for calling other apps from code.
2. Take the App ID from `zapier/.zapierapprc`. The redirect URI is
   `https://zapier.com/dashboard/auth/oauth/return/App<ID>CLIAPI/`.
3. Generate a client id and a long random secret, then:
   - `zapier env:set <version> CLIENT_ID=… CLIENT_SECRET=…`
   - On auth-worker, for each environment: set `ZAPIER_CLIENT_ID` and
     `ZAPIER_REDIRECT_URI` as vars, and run
     `wrangler secret put ZAPIER_CLIENT_SECRET --env <env>`.
4. Apply migration `0178_mcp_oauth_codes_access.sql`.

## Public listing checklist

- [ ] Privacy policy has a section on integrations you connect (aquilla-marketing `/privacy`)
- [ ] Terms have a third-party integrations clause (`/terms`)
- [ ] Help page at help.aquilla.app (automation/zapier)
- [ ] 256×256 logo, app description, category
- [ ] Reviewer test account on production with a seeded project
- [ ] Every trigger and action tested with a live Zap on production
- [ ] Submitter's email is at the app's domain (Zapier checks domain ownership)
