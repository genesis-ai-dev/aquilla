# SEO — how a client-rendered SPA still gets indexed

> **Picking up SEO work on this site? Start with `docs/SEO-WORKPLAN.md`** — it's the ordered
> hand-off (what's done, what's broken, what to do first). This file is the build mechanics it
> refers to. `docs/SEO-STRATEGY.md` is the longer-range plan after that.

The workspace is a client-rendered SPA. That is fine for the app itself, but the
marketing surface (`/`, `/beta`, the case studies) has to be legible to things
that never run our JavaScript: search crawlers on a render budget, AI answer
engines, link unfurlers, and visitors with JS blocked.

The answer here is **build-time prerendering of the marketing entries**, not SSR.
Nothing runs on the server at request time; `pnpm build` writes the finished HTML
into `dist/*.html` and the same static files ship.

## Where the pieces live

| Piece | File |
| --- | --- |
| Which pages get prerendered, at which URL, and whether they're indexable | `scripts/prerender-marketing.ts` (`MARKETING_PAGES`) |
| The React elements rendered at build time | `src/prerender/marketing-pages.tsx` |
| Page ids, JSX-free so the Node tsconfig can import them | `src/prerender/pages.ts` |
| Which URL actually serves which file | `worker/index.ts` (`STATIC_PAGES`) |
| Tests, including manifest ↔ worker parity | `scripts/prerender-marketing.test.ts`, `src/prerender/marketing-pages.test.tsx` |

## What the build does

`pnpm build` runs `vite build`, then `tsx scripts/prerender-marketing.ts <brand>`,
which for each marketing entry:

1. bundles `src/prerender/marketing-pages.tsx` for Node (a small `vite --ssr`
   build into `node_modules/.aquilla-prerender`, removed afterwards),
2. renders the page with `react-dom/server`,
3. replaces the hand-written stub inside `#root` in `dist/<entry>.html`,
4. adds `<link rel="canonical">`, a per-page `og:url`, and JSON-LD,

then writes `dist/sitemap.xml` and `dist/robots.txt` from the same manifest.

## Prerender, not hydrate — and why

The client entries still call `createRoot()`, which **clears `#root`** and renders
the live page over the prerendered copy. We deliberately do not hydrate.

The marketing pages branch on state that only exists in the browser: the theme
(`sessionStorage` → OS preference) and the `aq_hint` auth cookie, which decides
whether the nav says "open app" or "log in". Under hydration those become
mismatches on the first client render. Prerender-and-replace costs one extra
paint of markup that is already styled by the same CSS, and in exchange the
client keeps branching freely on browser state.

Two consequences worth knowing:

- **`#aq-prerender` is the wrapper**, and it is what makes the shell disposable —
  the reveal-animation reset (`homepage.css`) and the theme-stamp script both
  scope to it, so both vanish when React clears the container.
- **Anything the prerendered page renders must be safe without a DOM.** The build
  renders in Node, where there is no `window`, `document`, or `sessionStorage`.
  `hasAuthHintCookie()` returns `false` there, so the prerendered page is always
  the signed-out variant. `src/prerender/marketing-pages.test.tsx` is the guard.

## The guard rails

`pnpm build` fails rather than shipping a page that reads as empty:

- a render under 1 kB, or under `MIN_CRAWLABLE_TEXT` (1200) chars of readable
  text once tags are stripped;
- not exactly one `<h1>`, a missing canonical, or missing JSON-LD;
- a `/assets/…` URL in the prerendered markup that the client build didn't emit
  (the SSR and client builds hash asset content independently — this catches a
  drift that would otherwise surface only as a broken image in the pre-mount
  paint).

## Adding a marketing page

1. Add the `.html` entry and the vite input in `vite.config.ts`.
2. Add the route to `STATIC_PAGES` in `worker/index.ts`.
3. Add the component to `src/prerender/marketing-pages.tsx` and its id to
   `src/prerender/pages.ts`.
4. Add the manifest row in `scripts/prerender-marketing.ts` — `path` must match
   the worker route, and `indexable: false` for anything unlisted.

The parity test in `scripts/prerender-marketing.test.ts` fails if steps 2 and 4
disagree.

## Crawl surface

`dist/robots.txt` is generated, not checked in. It disallows the SPA-only routes
(`/project/`, `/settings`, `/join/`, …) — they render nothing without JS and
several are private — plus any manifest page marked non-indexable, and points at
`/sitemap.xml`.

The homepage is served at both `/` (signed-out visitors, via the `aq_hint`
cookie) and `/homepage`; `/` is canonical, and `/homepage` is not in the sitemap.

`/bible-translation` stays deliberately unlisted: `noindex` in its `<head>`,
`Disallow` in robots.txt, absent from the sitemap. It is still prerendered, so a
direct link unfurls and reads correctly.

## Not covered here

The E2E stack builds with plain `vite build` (see `scripts/e2e-up.ts`), so specs
run against the unprerendered stub, as they did before. The prerender is verified
by the build itself and by the unit tests above.
