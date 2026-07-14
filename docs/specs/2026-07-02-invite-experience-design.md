# Invite experience: context, org-view email invites, OG image (FRO-471)

Date: 2026-07-02 · Status: approved (Ryder) · Ticket: FRO-471

## Problem

Biblica pilot feedback (Bob, invited to an org by Prabhu): the invite email/landing page
never says **which workspace/org** you were invited to or **who invited you**. Concretely:

- `/join-org/:token` (`JoinOrgPage.tsx`) renders a fully generic "You've been invited to
  join an organization on Aquilla." — there is no public org-invite preview endpoint, so
  the page has nothing to show.
- Emails mention the org/project name but never the inviter. `created_by` is already
  stored on both `project_invites` and `org_invites` and never surfaced.
- Invite links unfurl with the default brand OG image; only `/join/*` (not `/join-org/*`)
  gets the invite-specific og:title/description rewrite in `worker/index.ts`.
- From the org Members page, the "Add to projects" dialog's email mode sends nothing —
  it tells the operator to open each project's Share panel.

## Decisions (user-approved)

1. **Org-view invites**: make "Add to projects" email mode actually mint per-project
   email-bound invites (server already sends the email for email-bound invites). Keep
   existing permission gates as-is.
2. **OG image**: generic branded invite image, no names in the unfurl (deliberate: link
   previews are visible to anyone the link is forwarded to and to scrapers). The landing
   page carries the personalized details.

## Design

### A. Invite context end-to-end

Backend (auth-worker):
- **New public `GET /api/v2/orgs/invite-preview/:token`** mirroring
  `GET /api/v2/projects/invite-preview/:token` guards (token ≥8 chars, unused, unexpired,
  org exists). Returns `{ orgId, orgName, role: {level, name}, expiresAt, email,
  invitedBy: string | null }` where `invitedBy` = inviter display name (fallback username)
  joined from `created_by`.
- **Extend `GET /api/v2/projects/invite-preview/:token` and `GET /api/v2/invites/:token/preview`**
  with `invitedBy` and `orgName` (project → org join).
- **Emails** (`services/email.ts`): project invite subject/body become
  "{Inviter} invited you to {project}" (+ "in {org}" in body); org invite becomes
  "{Inviter} invited you to join {org}". When the inviter name can't be resolved, fall
  back to today's copy. Route handlers thread the names through.

Frontend:
- **JoinOrgPage** fetches the new preview before accept and renders the summary-card
  pattern JoinPage uses: org name, "Invited by {name}", role. If the preview errors
  (old/used/expired token, transient failure), fall back to today's generic copy —
  never block the accept button on preview availability.
- **JoinPage** adds "Invited by {name}" and the org name to the existing summary card
  (single- and multi-project variants).

### B. Send project email invites from the org view

- `MultiProjectInviteDialog` email mode: replace the "open each project's Share panel"
  guidance with real sends — for each selected project call the existing
  `createServerInvite(jwt, projectId, role, undefined, email, expiresInDays=30)`.
  Per-project success/error rows identical to username mode. The mint endpoint requires
  project-lead (≥500); failures surface inline per project. No backend change.

### C. Generic branded invite OG image

- Add a 1200×630 branded "You're invited" image: SVG source committed under
  `worker/og/`, rasterized PNG committed at `public/og-invite.png` (served by the SPA
  asset pipeline).
- `worker/index.ts`: extend the invite meta rewrite to also set
  `og:image`/`twitter:image` to `${url.origin}/og-invite.png`, add `twitter:card`
  handling if needed, and trigger the rewrite for `/join-org/*` in addition to `/join/*`.
- index.html needs `og:image`/`twitter:image` tags present (brand default) so the regex
  rewrite has a target; add them if missing.

## Non-goals / flagged

- Emails hardcode "Aquilla" — per-deploy brand pass (Biblica stealth-branding) is a
  separate concern.
- Dynamic per-invite OG images with names: rejected for now (leaks to unfurlers).
- Org-wide invite gate stays Owner-only.

## Testing

- auth-worker unit tests: new org preview endpoint (guards + payload), `invitedBy`/
  `orgName` on both project previews, email content includes inviter + org.
- Vitest: JoinOrgPage renders preview data + generic fallback; MultiProjectInviteDialog
  email mode calls createServerInvite per selected project and reports per-project state.
- Worker: meta rewrite covers `/join-org/*` and rewrites the image tags.
- Live QA on the seeded dev stack per AGENTS.md before claiming done.
