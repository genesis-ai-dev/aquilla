# Splitting the marketing site from the app

*Design note, July 2026. Written to answer: "we'll eventually want tons of marketing URLs —
comparison pages, content angles. How do we make this scalable and simple for a team that
doesn't want to track a million things?"*

> **Status, 2026-07-31: the low-churn half of this is implemented.** `/` now serves the marketing
> homepage to every visitor with no cookie branch, identity moved to the browser
> (`AppEntryBanner`), and `/app` is the workspace entry. That captured the cacheability win, the
> "static marketing is the default" behaviour, and the deletion of the switch — **without moving a
> single app URL.** The subdomain below remains the eventual destination, not an urgent one; §4
> is now optional future work rather than a plan of record.

**Recommendation: serve one marketing page at `/` to everyone and resolve identity client-side
(done), then move the app to `app.aquilla.app` when the marketing surface justifies it.**
Reasoning below, including the part where the premise we were working from turns out not to match
what Linear and Cursor actually do.

---

## 1. The premise, checked

The plan on record was *"top level domain routes to app or marketing based on user — Cursor and
Linear do this."* Measured on 2026-07-31:

```
linear.app/    cache-control: s-maxage=1800, stale-while-revalidate
               vary: RSC, Next-Router-State-Tree, … (no Cookie)
               cf-cache-status: DYNAMIC

cursor.com/    cache-control: public, max-age=0, must-revalidate
               x-vercel-cache: HIT       age: 2386
               vary: rsc, next-router-state-tree, … (no Cookie)
```

Neither varies on `Cookie`, and both are shared-cached — Linear's root for 30 minutes, Cursor's
served from cache 40 minutes old. **Both serve one marketing page at `/` to every visitor,
signed in or not.** The app lives elsewhere: Linear under `/<workspace-slug>/…`, Cursor under
`/dashboard`. Neither switches the root on identity.

This matters twice over:

1. It removes the main argument for keeping the cookie switch.
2. **A cookie-dependent root can never be edge-cached.** Ours is currently forced to
   `private, no-store`. Linear caches the equivalent page for 30 minutes. On the single most
   important URL on the site, we've been paying an origin round-trip per visit for a feature the
   products we were copying don't have.

And the switch doesn't work anyway — see `docs/SEO-WORKPLAN.md` §1.2. Cloudflare's asset router
resolves `/` to `index.html` before the Worker runs, so `aquilla.app/` has been serving the empty
app shell to every signed-out visitor and crawler. `run_worker_first = ["/"]` fixes it, but the
better question is whether that logic should exist at all.

## 2. The actual problem isn't the domain

It's that **"is this URL marketing or app?" is answered by an enumerated list**, in two places —
`STATIC_PAGES` in `worker/index.ts`, and the `Disallow` denylist in the generated `robots.txt`.
Both must be extended by hand as either side grows. That's the "million things to track."

Cursor, the product cited as the model, is living this. Their `robots.txt`:

```
Disallow: /dashboard
Disallow: /*/dashboard
Disallow: /agents
Disallow: /*/agents
Disallow: /settings/
Disallow: /*/settings/
Disallow: /team/accept-invite
Disallow: /team/free-trial
Disallow: /team/new-team
```

Every app surface, hand-maintained, doubled for their locale prefix. Add a route, remember to add
two lines. Forget, and it's indexable. That is precisely the failure mode to design out.

Linear avoids it differently: their app namespace is *structurally* distinguishable
(`/<workspace-slug>/…`) and auth-gated, so they only disallow `/api/` and `/cdn-cgi/`. Their
sitemap carries **952 marketing URLs** on the apex — proof the "tons of marketing URLs" target
works fine on a shared domain *if* the split is structural rather than enumerated.

**So the design rule is: make the answer derivable, never enumerated.** There are two ways.

## 3. The two structural options

### Option A — subdomain: `app.aquilla.app` (the eventual destination)

The **host** answers the question. Nothing to list, ever.

- Marketing owns 100% of the apex namespace, permanently. `/pricing`, `/compare/*`, `/library/*`,
  `/blog/*` — no collision check, no worker route to add.
- `robots.txt` becomes two static files that are never edited again: apex allows everything and
  points at the sitemap; `app.aquilla.app` is `Disallow: /`.
- The apex can return **real 404s**, because it has a finite known page set. That fixes the
  soft-404 problem (`docs/SEO-WORKPLAN.md` §1.3) for free rather than as a separate project with
  a hand-kept route allowlist.
- **The apex becomes edge-cacheable.** No cookie dependency, so marketing gets long `s-maxage`
  like Linear's. Direct Core Web Vitals win on every marketing page.
- Marketing can later move to a CMS or static host without touching the app, and app deploys stop
  being able to break the marketing site.
- The cookie switch and `run_worker_first` both get deleted. The apex is always marketing.

### Option B — invert the default on one domain

Keep one host, but flip which side is opt-in: the app shell is `noindex` by default (**already
shipped on the current branch**) and each marketing page is individually indexable because it has
its own prerendered HTML entry. New app route → noindex automatically. New marketing page →
indexable automatically. Zero maintenance for *indexing*.

What Option B does **not** solve: URL collisions between marketing and app, soft-404s, crawl
budget spent on app URLs, and the uncacheable root. It's a good stopgap — and it's live now — but
it doesn't make the namespace question go away.

### Not recommended: app under `/a/*` or `/app/*`

Same migration cost as Option A (every app URL moves) without the operational separation —
still one deploy, one cache policy, one robots file, and marketing still can't own the apex
cleanly. If we're paying the migration cost, pay it once for the subdomain.

## 4. Migration — what it actually costs

*Not scheduled. Retained because the costs don't change, and knowing them is what made the
low-churn path obviously correct to do first.*

Mechanical, and mostly derivable from `src/App.tsx` rather than hand-written.

1. **Stand up `app.aquilla.app`** serving the same Worker + SPA assets. Both hosts live at once.
2. **Apex Worker: 301 known app routes** to `app.aquilla.app` + path. Derive the route list from
   `App.tsx` so it can't drift. Everything else on the apex is marketing or a real 404.
3. **Shared-link routes need care.** `/join/:token`, `/join-org/:token`, `/link/:token`,
   `/approve/:changesetId` are in people's email and chat history. A 301 handles them —
   browsers follow it — so keep those redirects permanently rather than sunsetting them.
4. **`/oauth/callback` is registered with Monday.com.** OAuth redirect URIs must match exactly
   and a 301 may break the flow. Register `app.aquilla.app/oauth/callback` alongside the existing
   one, cut over, then remove the old one. This is the one step with an external dependency.
5. **Cookies.** `aq_hint` is deliberately host-only today (`session-store.ts`). If the apex still
   wants to show "Open app" vs "Sign up", it needs `Domain=.aquilla.app` — acceptable for a
   1-bit non-credential hint, though it then rides on every subdomain request. **Check the auth
   session cookie's scope before cutover**: if it's host-only, moving hosts logs everyone out
   once. Worth doing deliberately and announcing rather than discovering.
6. **Delete** the `aq_hint` root switch, `run_worker_first`, and the `STATIC_PAGES` map.
7. **E2E**: `e2e/` page objects and `scripts/e2e-up.ts` hardcode a single origin. Two-origin
   local dev needs a plan before this lands.

Deliberately *not* part of this: auto-redirecting signed-in visitors from the apex to the app.
Linear and Cursor don't, it's what broke, and it's what makes the root uncacheable. Marketing
shows an "Open app" link; that's it.

## 4a. What actually shipped instead

The user's framing — *"minimise churn, just do what Cursor does: show everyone the homepage,
check login afterwards, and steer signed-in users with an obvious UX"* — gets most of the value
for none of the migration cost:

- **`worker/index.ts`**: `/` serves `homepage.html` unconditionally. No cookie branch. Response is
  identical for every visitor, so it carries `public, max-age=0, s-maxage=600,
  stale-while-revalidate=86400` instead of `private, no-store`.
- **`AppEntryBanner`**: reads the session from IndexedDB after mount and offers a signed-in
  visitor their workspace. Additive, so no flicker; renders `null` without a DOM, so the
  prerendered page stays identical for everyone; keys on session *presence*, not validity,
  because a stale token is better handled by `/app` than by hiding the door.
- **`/app`**: the workspace entry (`AppEntry`, mounted at `/app` and `/`), sending signed-out
  visitors to `/login`. Marketing's "Open app" link is now unconditional — no identity read in a
  cached page.

What this does **not** solve, and what still argues for the subdomain eventually: URL collisions
as the marketing surface grows, and soft-404s (§1.3 of the workplan).

## 5. The test: what does the team track afterwards?

| Task | Today | After |
|---|---|---|
| Add a marketing page | Add HTML entry, vite input, `STATIC_PAGES` route, manifest row; check it doesn't collide with an app route | Add the page. It's live and indexable. |
| Add an app route | Remember to add a `robots.txt` `Disallow`; check it doesn't collide with marketing | Add the route. |
| Keep the app out of search | Maintain a denylist that grows forever | `Disallow: /` on one subdomain, written once |
| Serve a real 404 | Needs a hand-kept route allowlist in the Worker | Apex 404s anything not a marketing page |
| Cache the homepage | Can't — cookie-dependent, `private, no-store` | Long `s-maxage`, like Linear |

That table is the whole argument.

## 6. Open questions before committing

1. **Auth session cookie scope** — host-only or already `.aquilla.app`? Determines whether cutover
   logs everyone out.
2. **Who owns the Monday OAuth app registration**, and can both redirect URIs be registered during
   transition?
3. **Two-origin local dev and E2E** — how much work is `scripts/e2e-up.ts`?
4. **Timing.** This is cheapest now and gets more expensive with every shared link that goes out.
   But it should not block the Phase 0–1 SEO work in `docs/SEO-WORKPLAN.md`, none of which
   conflicts with it: metadata, internal links, and query research all survive the move intact.
