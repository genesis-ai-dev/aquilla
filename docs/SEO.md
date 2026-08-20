# SEO ownership

Aquilla's indexable public surface is owned by the sibling
`~/frontierrnd/aquilla-marketing` repository, not this application repository.

## Repository boundary

`aquilla-marketing` owns:

- `/`, `/homepage`, `/beta`, and `/bible-translation`;
- `/case-studies/*`, `/privacy`, and `/terms`;
- `sitemap.xml`, `robots.txt`, canonical metadata, JSON-LD, and prerendering;
- the `/mkt/*` asset namespace; and
- the `aquilla-marketing` Cloudflare Worker and its route-parity tests.

`aquilla` owns:

- the client-rendered SPA and its `index.html` shell;
- application routes, including `/app`, `/project/*`, and `/orgs/*`;
- invite-link social metadata rewriting in `worker/index.ts`; and
- the `aquilla-web` catch-all Worker route.

Cloudflare selects the marketing Worker for its specific route patterns before
considering the app Worker's `aquilla.app/*` catch-all. The two repositories can
therefore deploy independently while sharing the same origin.

## App-shell indexing policy

The SPA shell carries `<meta name="robots" content="noindex, follow">`. App routes
are client-rendered, often private, and do not provide useful crawlable content.
Do not add an indexable public page as an SPA route: add it to
`aquilla-marketing`, including its Vite input, prerender manifest entry, Worker
route, sitemap policy, and tests.

The app build runs `scripts/check-app-build.ts` after Vite. It fails if legacy
marketing HTML, sitemap/robots, or the `/mkt` asset namespace reappears in
`dist/`.

Historical SEO strategy and audit documents in this repository describe the
pre-extraction implementation. Use the marketing repository's README and tests
as the current source of truth for public-page mechanics.
