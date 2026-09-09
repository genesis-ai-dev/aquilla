# Visit every route without a crash

Smoke twin: `e2e/specs/projects/route-health.smoke.spec.ts`

## Preconditions

- Logged in as `alice`.
- Dev Org is org id 9.
- The seeded project `bestalu-bible` exists at project id `41ee4729-6862-51b1-b89c-47401d1a7850`.

## Steps

1. Open each org-level route in turn: `/`, `/projects`, `/orgs/9/archived`, `/orgs/9/assigned`, `/orgs/9/teams`, `/orgs/9/members`, `/orgs/9/settings`, `/preferences`.
2. After each route loads, check the page for the crash boundary text **Something went wrong** and for a `vite-error-overlay` element. Neither should be present.
3. Open each project-level route for the seeded project: `/project/41ee4729-6862-51b1-b89c-47401d1a7850/editor`, `.../settings`, `.../settings/members`, `.../settings/rules`, `.../settings/memory`, `.../rules`, `.../terminology`, `.../comments`, `.../memory`, `.../memory/instructions`, `.../memory/quality`, `.../voice`.
4. Check each of those the same way as step 2.

## Expected end state

- Every route in the list loads with no **Something went wrong** text and no `vite-error-overlay` element in the DOM.

## Counts as a failure

- Any route shows the crash boundary text **Something went wrong**.
- Any route leaves a `vite-error-overlay` element in the DOM.
- A route 404s or bounces to a sign-in screen instead of rendering. Alice is already signed in, so a sign-in bounce means the session was lost, not that the route is healthy.

## Notes for the agent

- `/` and `/projects` land on `/orgs/all`, not `/orgs/9/...`, because alice belongs to more than one org in this dev stack. That redirect is expected; it is not a crash.
- `settings/rules`, `settings/memory`, and `rules` are legacy paths. They redirect into the Living Memory surface (`/memory` or `/memory/quality`) per AQU-932. Judge the page that actually loads, not the URL you typed.
- Reading `document.body.innerText` with `eval --stdin` is the reliable way to check for the crash text across this many routes. A snapshot works too but costs more per route for a sweep this wide.
