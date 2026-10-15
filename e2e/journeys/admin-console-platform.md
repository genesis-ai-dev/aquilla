# Reach the site-wide admin console and open its Platform tab

Smoke twin: none. The console's sections are covered at RTL level
(`src/components/admin/*.test.tsx`, `AdminElevationGate.test.tsx`) and its
routes by `auth-worker/src/__tests__/admin-routes.test.ts`. This story exists
because neither of those can tell you whether a *deployed* target lets a
platform admin in at all — which is the thing that kept coming back
NOT CHECKED (AQU-1353).

## Preconditions

- Signed in as the **platform-admin fixture**, which is a different account
  from the one the other stories use. Platform admin is an allowlist of
  account emails (`ADMIN_EMAILS`), a separate axis from the org role ladder,
  so no amount of org permission reaches it.
  - Local stack: the seeded `dev` user.
  - A preview: the `qa-admin` account on development storage.
  - `login_admin` in `replays/_lib.sh` picks the right one per target.
- The target is the local stack or a branch preview. **Not production**: the
  console is cross-tenant, and the step-up code there goes to a real inbox.

## Steps

1. Open `/admin`.
2. If a panel headed **Admin verification required** appears, the target has
   step-up elevation on (a preview does). Click **Email me a code**. The panel
   then shows a line reading **Dev mode — your code is NNNNNN** — a target with
   no mail binding hands the code back instead of emailing it. Type those six
   digits into the code field; it verifies itself on the sixth digit.
3. A level-1 heading reads **Admin console**.
4. Read the tab strip. It lists **Overview**, **Retention**, **Migration**,
   **Tenants**, **Teams**, **People**, **Projects**, **Activity**, **Platform**.
5. Click **Platform**.
6. Read the sub-tabs inside it: **AI settings**, **AI credits**, **Billing**.

## Expected end state

- The URL is still `/admin` — it never bounced to `/orgs/all` or `/`.
- A level-1 heading reads **Admin console**, and the tab strip lists all nine
  tabs from step 4.
- The Platform tab is selected and shows the three sub-tabs from step 6.
- The left sidebar carries an **Admin** link (it renders only for a platform
  admin), so the console is reachable by navigation and not only by URL.

## Counts as a failure

- `/admin` redirects to `/orgs/all` or `/` — the account is not on the
  target's `ADMIN_EMAILS`, so there is no admin fixture on this target.
  Report it as a missing fixture, not as an app bug.
- **Admin verification required** stays on screen after a correct code, or the
  code line never appears after **Email me a code** — the step-up flow is
  broken on this target.
- The console loads but a tab from step 4 is missing, or Platform is missing
  any of its three sub-tabs.
- Any section renders the error text instead of content (a 403 "elevation
  required" from `/api/v2/admin/*` reads as an error line, not an empty tab).
- The sidebar has no **Admin** link while `/admin` nevertheless loads, or the
  reverse.

## Notes for the agent

- **Do not write anything.** Overview, Retention, Tenants, Teams, People,
  Projects and Activity are read-only, but the Platform tab is editable and
  its settings are **platform-wide** — an AI-settings or credits change there
  lands on every org on development storage, including every other story's
  fixtures. Walk it, read it, change nothing.
- The elevated session lasts about six hours and is bound to the credential
  that earned it, so a fresh login needs a fresh code. Re-running this story
  back to back will ask again if the session changed.
- Elevation is **off** on the local stack (`WRANGLER_LOCAL=1` bypasses it), so
  step 2 is a no-op there and the console loads straight away. That difference
  is config, not a build difference — don't report it as one.
- The code field is an OTP input. Focus its first slot and type the six digits;
  typing at "current focus" without focusing it first is lost.
- `/admin` ignores a `?tab=` query. Both the top-level tabs and the Platform
  sub-tabs are component state, so every tab is reached by clicking and the URL
  stays `/admin` throughout. A walk that reports a tab from the URL has not
  checked it. (`/admin?tab=credits` loads the Overview tab, not Credits — that
  is current behaviour, not a bug to file.)
