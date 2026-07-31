# SEO work plan — start here

*A hand-off document. If you've just been given this branch, read this file top to bottom before
touching anything. July 2026.*

**Related reading, in this order:** this file → `docs/SEO.md` (how the prerender build works, and
the rules it enforces) → `docs/SEO-STRATEGY.md` (the longer-range pSEO/AEO plan, only relevant
once the phases below are done).

---

## What this is

The site is a client-rendered SPA with five standalone marketing pages. Until this branch,
crawlers saw a ~230-character stub on every one of them. That part is fixed. What follows is
everything *else* that needs to change, in the order it should be done.

**Baseline, so you can tell whether any of this worked.** PostHog, aquilla.app, last 90 days:

| Channel | Visitors | Pageviews |
|---|---|---|
| Direct | 237 | 3,914 |
| Referral | 63 | 637 |
| **Organic Search** | **6** | **9** |
| Email | 1 | 1 |

Six organic visitors in a quarter. Write that number down — every claim of improvement should be
measured against it.

---

## Already done on this branch — don't redo these

Read `docs/SEO.md` for the mechanics. Summary of what shipped:

- **Marketing pages are prerendered at build time.** `pnpm build` renders each React marketing
  page to static HTML and injects it, so crawlers get the whole page. Homepage went from ~230
  chars of readable text to ~8,000. Verified with JS disabled in a real browser.
- **`sitemap.xml` and `robots.txt` are generated** from a manifest in
  `scripts/prerender-marketing.ts`. Both were previously absent or near-empty.
- **Canonical URLs, per-page `og:url`, and JSON-LD** are injected per page.
- **App-only routes are disallowed** in robots.txt (`/project/`, `/settings/`, `/join/`, …) —
  they render nothing without JS and several are private.
- **The build fails** if a page would ship thin: under 1,200 chars of readable text, not exactly
  one `<h1>`, missing canonical, missing JSON-LD, or a broken asset reference. You cannot
  accidentally regress the prerendering.
- **Marketing fonts moved into `<head>`** so pages paint in their real typeface immediately.
- **`run_worker_first = ["/"]`** in `wrangler.toml` so the bare domain serves the marketing
  homepage instead of the empty app shell — see §1.2, and verify it after the next deploy.
- **The app shell is `noindex`.** `index.html` carries `<meta name="robots" content="noindex,
  follow">`; every marketing page has its own prerendered entry, so this covers the app surface
  without a robots.txt denylist. If you add a marketing page, give it its own entry — a SPA
  route would inherit the noindex.

**Important:** it is *prerender-and-replace*, not hydration. React clears `#root` and re-renders
over the static copy. If you add anything to a marketing page, it must render without a DOM —
no `window`, `document`, or `sessionStorage` during render. `src/prerender/marketing-pages.test.tsx`
is the guard, and it will fail if you break this.

---

## Phase 0 — Get instruments before changing anything

You cannot iterate on data you don't have. **Nothing below Phase 1 is worth doing until this
phase is done**, and none of it is code.

- [ ] **Verify Google Search Console** for `aquilla.app` (DNS TXT record is easiest). Submit
      `https://aquilla.app/sitemap.xml`.
- [ ] **Verify Bing Webmaster Tools** and submit the same sitemap. Bing matters more than its
      market share suggests — ChatGPT's retrieval leans on it.
- [ ] **Turn on Core Web Vitals capture in PostHog.** I checked: there is currently *zero* web
      vitals data for the last 90 days. Any performance work right now would be guesswork.
- [ ] **Record the baseline** above in a doc or dashboard so improvement is provable.

Expect no useful GSC data for 7–14 days after verification. Start Phase 1 while you wait.

---

## Phase 1 — Fix what's already shipped

These are concrete defects on live pages. Each is small. Do them first because they cost hours,
not weeks, and they affect the pages that already exist.

### 1.1 The homepage has the weakest metadata on the site

This is the single highest-value fix in this document.

```
Current:  <title>Aquilla</title>
          <meta name="description" content="Aquilla — translators, lifted.">
```

The most important page on the site carries the brand default. Compare to the case studies,
which are already good:

```
<title>Come and See — Aquilla</title>
<meta name="description" content="How Come and See set the Guinness World Record for the most
translated streaming season — twice — reaching 125 languages with one expert and Aquilla.">
```

The title needs to say what the product *is* for someone who has never heard of it, in ~55–60
characters, leading with the thing people search rather than the brand name. The description
needs to earn a click in ~150 characters. Do this **after** Phase 2 (below) so the words are
chosen from real queries rather than from taste.

Files: `homepage.html`. Note the title/description there use `%BRAND_*%` placeholders resolved
by `scripts/vite-html-branding.ts` — the homepage needs its own literal strings, the way
`beta.html` and the case studies already do.

### 1.2 The root URL served an empty shell — fixed here, verify after deploy

**This was the single worst SEO defect on the site and it hid behind a passing test.**

`https://aquilla.app/` was returning the empty SPA shell (`<div id="root"></div>`) to everyone —
byte-identical to a nonexistent path. Not the marketing homepage. Verified against production:

```
/                              200  8501b   <- empty SPA shell
/this-page-does-not-exist-9f3a 200  8501b   <- byte-identical
/homepage                      200  7544b   <- the actual marketing page
```

Two causes stacked. **Cloudflare's asset router runs before the Worker** and resolves `/` to
`index.html`, so the Worker's root branch never executed. And that branch was switching on the
`aq_hint` cookie, which meant the response could never be cached even once it did run.

`worker/index.test.ts` asserted *"GET / with no cookie serves homepage.html"* and passed
throughout — it calls the Worker's `fetch` directly, so it never saw the asset router.

**Both are fixed on this branch:**

- `run_worker_first = ["/"]` in `wrangler.toml` (all four assets blocks), so the Worker actually
  handles the root. Config-contract test in `worker/index.test.ts`, verified to fail without it.
- **`/` now serves the marketing homepage to everyone**, with no cookie branch at all. Identity
  moved to the browser — `AppEntryBanner` reads the session after mount and offers signed-in
  visitors a way into the workspace. See §1.2a.

Verified by running the real Worker against the real build: `/` returns 8,221 readable chars,
byte-identical with and without `aq_hint=1`, `Cache-Control: public, max-age=0, s-maxage=600,
stale-while-revalidate=86400`, no `Vary: Cookie`.

**After the next deploy, confirm it:**

```bash
curl -s https://aquilla.app/ | grep -o '<title>[^<]*</title>'
curl -sI https://aquilla.app/ | grep -i cache-control   # expect: public … s-maxage=600
# and the point of the whole exercise — real content with no JS:
curl -s https://aquilla.app/ | sed 's/<[^>]*>/ /g' | tr -s ' ' | head -20
```

### 1.2a The app entry is now `/app`

Because `/` is marketing for every visitor, it can no longer double as the app home. `/app` is
the workspace entry (`AppEntry` in `src/App.tsx`, mounted at both `/app` and `/`), and it sends
signed-out visitors to `/login` rather than bouncing them back to the page they just left.

Two rules follow, and they matter if you touch the marketing pages:

- **Marketing pages must not read identity while rendering.** They are prerendered at build time
  and edge-cached, so their markup has to be the same for everyone. The nav's "Open app" link is
  unconditionally `/app`; it used to branch on the `aq_hint` cookie.
- **Steer signed-in visitors with additive UI, never by mutating existing UI.** `AppEntryBanner`
  appears alongside the hero rather than rewriting the call to action, so there's no flicker when
  the session check resolves. `src/prerender/marketing-pages.test.tsx` fails if identity-dependent
  markup leaks into the prerendered page.

### 1.3 Every unknown URL returns HTTP 200 (soft 404)

`not_found_handling = "single-page-application"` means **any** path returns 200 with the SPA
shell. `/this-page-does-not-exist-9f3a` → `200`. The `NotFound` React component renders a
"Page not found" message client-side, but the HTTP status is still 200.

Google calls this a soft 404 and reports it in Search Console. The practical harm: the URL space
is infinite and every bogus URL looks valid to a crawler, so crawl budget gets spent on nothing.

**Not fixed here — it needs a decision.** The Worker would have to know which SPA routes are
real in order to 404 the rest, which means an allowlist of route prefixes that has to stay in
sync with `src/App.tsx`. Get it wrong and you 404 a real page. See §"App and marketing share one
namespace" below, because this is the same question in a different costume.

### 1.4 Pricing has no URL

The homepage carries seven topics on one URL:

```
#top  #workspace  #multimodal  #languages  #quality  #steering  #pricing
```

Anchors are not pages. A page that covers seven topics ranks well for none of them, and
`#pricing` in particular is a high-intent query with nowhere to land. **Split pricing onto its
own URL** (`/pricing`) as a first move, and consider one more later — the "languages" section is
the other credible candidate.

How to add a page: `docs/SEO.md` §"Adding a marketing page" has the four-step checklist. There's
a parity test that fails if you do only some of the steps.

### 1.5 Internal links point at the non-canonical URL

The homepage is served at both `/` and `/homepage`. Canonical is `/`. But both case studies link
back to **`/homepage`** — so the two strongest internal links on the site point at the alias
instead of the canonical URL.

Fix: change `href="/homepage"` to `href="/"` in `src/pages/CaseStudy/ComeAndSee.tsx` and
`src/pages/CaseStudy/Biblica.tsx`.

### 1.6 The case studies are orphans

The homepage links to both case studies (good). Neither case study links to the other, or to
`/beta`. Add cross-links — a short "more stories" block at the foot of each case study. Cheap,
and it's the standard fix for pages that never get crawled deeply.

### 1.7 `/privacy-policy` is still client-rendered

It's a SPA route (`src/pages/PrivacyPolicy.tsx`), so it ships as an empty shell. It's a real page
people look for. Either promote it to a prerendered marketing entry, or accept it and move on —
but decide deliberately rather than leaving it as an accident.

---

## Phase 2 — Find the real queries

**Do not skip to writing pages.** The words on the page have to come from what people actually
type, and in this market the wrong vocabulary actively routes you to the wrong audience.

### 2.1 The vocabulary rule, before anything else

This market has two disjoint vocabularies and you must stay on one side of the line.

**Use these** (ministry/mission vocabulary — this is the audience):
Paratext · Scripture Forge · USFM · back translation · consultant check · mother-tongue
translator (MTT) · gateway language · heart language · oral Bible translation (OBT) · Scripture
engagement · print-ready typeset · low-resource languages · minority language · field partners ·
regional directors · discipleship · dubbing · subtitling

**Never use these** (commercial localization vocabulary — wrong audience entirely):
TMS · CAT tool · per-word · fuzzy match · MTPE · post-editing · XLIFF · locale · MQM · LQA · LSP ·
vendor management · `#l10n` · `#xl8` · continuous localization

Every term in the second list is a beacon for the commercial localization industry, where
Smartling and Phrase will match any claim within two quarters and where we have no relationships.
If a keyword tool hands you one of those terms with great volume, **discard it.** Volume from the
wrong audience is worse than no volume.

### 2.2 The autosuggest sweep (do this manually, it takes an afternoon)

Autosuggest is real query data, free, and better than most paid tools for a niche this small.

1. Open an incognito window. Google, then repeat on Bing and YouTube.
2. Type a seed phrase and **stop before pressing enter.** Write down every suggestion.
3. Then run the alphabet trick: seed + " a", seed + " b", … through "z". Each letter surfaces a
   different set.
4. Also try the question forms: "how to…", "what is…", "best… for…", "… vs …", "can you…".
5. After searching, scrape the **"People also ask"** box and the **"Related searches"** at the
   foot of the results page. Both are query data.

**Seed list to start from** — these come from real customer language, not guesses:

```
bible translation software
ai bible translation
paratext alternative
usfm to indesign
export paratext project
back translation tool
consultant check translation
translate ministry curriculum
translate church curriculum into other languages
oral bible translation software
low resource language translation
translation memory for bible translation
how long does bible translation take
ai translation quality check
subtitle translation for ministry
```

Also try the *problem* phrasings, because this buyer searches their symptom, not the category:

```
how to check a translation in a language i don't speak
translation project tracking spreadsheet
who reviews ai translation
is ai bible translation accurate
```

### 2.3 Free tools worth ten minutes each

AlsoAsked and AnswerThePublic (both have free tiers) expand a seed into a question tree.
Google Trends for relative direction only — absolute volumes are meaningless at this scale.
Once GSC has data (Phase 0), **the Performance → Queries report is better than all of them**,
because it's queries you already appear for.

### 2.4 The output

A spreadsheet: query · estimated intent (informational / comparison / commercial) · which
existing page could answer it · whether a page needs to exist. **Cluster it** — five queries that
want the same answer are one page, not five.

---

## Phase 3 — Say what the page is worth to the reader

Between "we know the queries" and "we write pages" there's a step that gets skipped, and skipping
it is why most SEO pages are worthless.

### 3.1 The one-sentence test, per page

For every page, existing or planned, write one sentence:

> **A [role] who [situation] comes here to [outcome], and leaves able to [specific thing].**

Worked example:

> A ministry ops lead who has just been handed a Paratext project comes here to find out whether
> they can get the text out into InDesign, and leaves knowing exactly which elements survive the
> round trip and which don't.

If you can't write that sentence, **the page should not exist.** This is not a formality; it's
the filter that stops the site filling with pages nobody needed.

### 3.2 The two-question test, per page

1. Would this page still be useful if search engines didn't exist?
2. If someone bookmarked it and came back in six months, would it still be worth the visit?

Both must be yes. A page that only exists to rank will eventually be treated as such.

### 3.3 Answer-first structure

Lead with the answer, then the reasoning. Not a preamble, not a definition of the industry, not
"in today's fast-moving world."

- First 40 words resolve the question in the title.
- `<h2>`/`<h3>` that are real questions someone typed.
- Short paragraphs, tables where a table is genuinely clearer.
- Cite primary sources with links.

This structure matters twice over: it's what readers want, and it's the shape that AI answer
engines can lift and cite. Both goals point the same direction.

### 3.4 A tone constraint specific to this audience

Read the ICP docs if you have access to them. The one thing to internalize: this buyer's most
common self-description is some version of *"I'm a dinosaur"* / *"I don't even know what
questions to ask."* They are senior, capable, and quietly worried about being behind.

**Any page that makes the reader feel behind repels exactly the person it was written for.** No
"you're still doing it the old way," no "most organizations are falling behind." Write as if the
reader already made the right call and just needs the next detail.

---

## Phase 4 — Then, and only then, new pages

With Phases 0–3 done you'll have queries, clusters, and a value sentence per page. Now build.

Suggested order, easiest and safest first:

1. **`/pricing`** — split from the homepage anchor (1.4 above).
2. **Format/interop pages** — "USFM to InDesign: what survives," "Getting your Paratext project
   out of Paratext," "USX vs USFM." We have ~20 real parsers in `src/lib/parsers/` with test
   fixtures, so these can be *accurate* in a way competitors' pages aren't. This is the highest
   value-per-effort content on the site and it answers questions customers have literally asked.
3. **Question pages** — one per cluster from Phase 2.
4. **Comparison page** — one, hand-written, honest, including where we're *not* the fit.

`docs/SEO-STRATEGY.md` covers what comes after this (a content graph, a much larger page
programme, and AI-answer-engine visibility). Don't start it until Phase 4 is underway.

---

## App and marketing share one namespace

> **There is now a full design note on this: `docs/specs/2026-07-31-marketing-app-namespace-design.md`.**
> Its recommendation is to move the app to **`app.aquilla.app`**, make the apex 100% marketing,
> and delete the cookie-based root switch. Read it before doing anything in this section — what
> follows is the interim position that holds until that lands.

**Short answer for right now: don't move the app under a path prefix like `/a`.** The SEO benefit
is ~95% achievable for one line, and a path prefix carries the same migration cost as the
subdomain with none of its operational upside.

### The situation

`worker/index.ts` maps a handful of marketing routes (`/`, `/homepage`, `/beta`,
`/case-studies/*`, `/bible-translation`) and hands **everything else** to the SPA. So the app
owns the entire remaining URL space by default, and each new marketing URL has to be carved out
of it. Two real consequences: robots.txt is an enumerated *denylist* of app paths that someone
must remember to extend, and every unknown path returns 200 (§1.3).

### Why the prefix isn't the answer

Moving the app to `/a/*` breaks every existing app URL, and some of those URLs live outside our
control:

- **`/join/:token`, `/join-org/:token`, `/link/:token`, `/approve/:changesetId`** are shared
  externally — they sit in people's email and chat history. They'd need permanent redirects
  forever, so the "clean split" is never actually clean.
- **`/oauth/callback`** is registered with Monday.com as an OAuth redirect URI. Changing it means
  editing an external app registration and coordinating the cutover.
- Every `navigate()` call, `<Link>`, e2e page object, deep link in a notification email, the
  Tauri shell, and every bookmark a customer has.

And after all that, **the search benefit over the one-line fix below is close to zero.**

### What we did instead

- **`<meta name="robots" content="noindex, follow">` on `index.html`** (this branch). Because
  every marketing page has its own prerendered HTML entry, `index.html` is *only* served for
  app routes and invite links. One rule now covers every app route, including ones nobody has
  written yet — which is the actual thing the prefix was going to buy. Social meta still works;
  noindex doesn't affect link unfurling.
- **`run_worker_first = ["/"]`** (§1.2), so the root URL serves the marketing homepage rather
  than the app shell.

Note the interaction: robots.txt `Disallow` and `noindex` don't stack. A path that's disallowed
is never fetched, so its `noindex` is never seen. That's fine — either one keeps a page out of
the index. Keep the `Disallow` entries for genuinely private routes (`/join/`, `/approve/`,
`/link/`) and let `noindex` cover the general app surface.

### What's still open: proper 404s

The remaining piece of the namespace problem is §1.3 — unknown paths return 200. The fix is an
allowlist of real route prefixes in `worker/index.ts`, 404ing anything else. Maybe 30 lines plus
tests, and the Worker already has its own suite.

The risk is that the allowlist drifts from `src/App.tsx` and starts 404ing real pages, which is
a user-visible break rather than an SEO regression. Worth doing, worth doing carefully, and it
should be its own PR with the route list derived from `App.tsx` rather than hand-copied.

### Where this is heading

A path prefix is the wrong shape — if we're paying to move every app URL, the subdomain buys
strictly more: an apex that can be edge-cached, real 404s, a `robots.txt` per host that is
written once and never edited, and marketing that can move to a CMS later without touching the
app. See the design note linked at the top of this section for the migration plan and its costs
(shared invite links, the Monday OAuth callback, cookie scope, two-origin E2E).

Nothing in Phases 0–3 conflicts with that move — metadata, internal links, and query research
all survive it intact — so don't block on the decision.

---

## How to verify your work

```bash
pnpm build            # fails if any marketing page would ship thin — read the error, it's specific
pnpm test             # includes the prerender + sitemap/robots + worker-route parity tests
```

Then check the artifact rather than trusting the build:

```bash
# What a crawler actually sees — no JS involved:
curl -s https://aquilla.app/ | sed 's/<[^>]*>/ /g' | tr -s ' ' | head -50
```

And in a browser: DevTools → Settings → Debugger → **Disable JavaScript**, then reload. If the
page still looks right and reads right, crawlers are fine.

---

## What not to do

- **Don't chase "AI church translation" keywords.** That's live sermon interpretation — a
  different product with well-established competitors. Different buyer.
- **Don't publish customer quotes without clearance.** There's a corpus of customer call
  transcripts, and most of it is *not* cleared for publication. Ask before quoting anyone, and
  never name a customer organization without written sign-off. Come and See in particular routes
  all public mention through a marketing department.
- **Don't add keyword-stuffed pages, doorway pages, or location pages.** There is no local angle
  here and thin pages will hurt a domain this small.
- **Don't remove the robots.txt disallows** on app routes. Those pages render nothing without JS
  and some are private.
- **Don't undo the prerendering** by adding browser-only code to a marketing page render path.
  The tests will catch it; read `docs/SEO.md` before working around them.

---

## Quick reference — the files that matter

| What | Where |
|---|---|
| Prerender build step, page manifest, robots/sitemap generation | `scripts/prerender-marketing.ts` |
| Which React page renders for each entry | `src/prerender/marketing-pages.tsx` |
| Which URL serves which file | `worker/index.ts` (`STATIC_PAGES`) |
| Marketing page HTML entries (titles, meta, OG tags) | `homepage.html`, `beta.html`, `case-study*.html` |
| Marketing page components | `src/pages/Homepage/`, `src/pages/Beta/`, `src/pages/CaseStudy/` |
| Shared marketing styles | `src/pages/Homepage/homepage.css` |
| Tests | `scripts/prerender-marketing.test.ts`, `src/prerender/marketing-pages.test.tsx` |
