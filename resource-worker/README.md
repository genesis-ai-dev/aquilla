# aquilla-resources — same-origin content proxy (AQU-627)

Hides third-party content domains from client traffic. Translators in
surveillance-sensitive contexts reach the app safely, but the SPA also makes
"sideways" fetches to third-party hosts (Door43/DCS, the Free Use Bible API,
the eBible corpus) — those leak meaningful domains in DNS/SNI on the
translator's network. This Worker forwards an **allow-listed** set of content
hosts from a subdomain of our own domain, so client traffic only ever names
`*.aquilla.app`.

## How it fits together

- **Client:** `src/lib/net/resource-proxy.ts` rewrites content base URLs to
  `https://resources.aquilla.app/<host>/<path>` **only** when the SPA is built
  with `VITE_RESOURCES_BASE` set. Unset → direct fetch, unchanged.
- **Server:** `src/lib/net/resource-proxy-handler.ts` (`proxyResourceRequest`)
  maps `/<host>/<rest>` → `https://<host>/<rest>`, restricted to the allow-list,
  GET/HEAD only, passing caching headers through. Unit-tested in the root suite
  (`src/lib/net/resource-proxy.test.ts`).
- **This Worker** (`index.ts`) is the Cloudflare glue + CORS preflight.

## Allow-list (the inventory)

Kept in `EXTERNAL_CONTENT_HOSTS` (`resource-proxy-handler.ts`):

- `git.door43.org` — DCS catalog/Gitea API + raw files + OBS repo
- `cdn.door43.org` — Door43 media (OBS images)
- `bible.helloao.org` — Free Use Bible API
- `raw.githubusercontent.com` — BibleNLP/ebible corpus + `translations.csv`

Intentional exceptions (not client content fetches, so out of scope): provider
calls already routed through our Workers (OpenRouter/chat, `api.aquilla.app`,
sync-worker), PostHog telemetry, build/migration tooling (gitlab, git-lfs), and
doc/reference links that are never fetched (matecat guides, huggingface,
OASIS/W3C schema URLs).

## Turn-on checklist (out-of-band — NOT done by CI / the AFK agent)

1. **Security review** of the allow-list + handler — this originated from a
   security call; confirm the fixed allow-list, GET/HEAD-only, no cookie/auth
   forwarding, and no open-proxy behaviour are acceptable.
2. **Claim the route + DNS record** with a local zone-perm token:
   `cd resource-worker && wrangler deploy --env=production` (CI's token can't
   sync zone routes — same convention as the other Workers).
3. **Build the production SPA with**
   `VITE_RESOURCES_BASE=https://resources.aquilla.app`, or the development SPA
   with `VITE_RESOURCES_BASE=https://resources.dev.aquilla.app`, so the client
   rewrites its fetches. This Worker has only production and development
   profiles; there is no third environment.
4. **Verify** with the browser network tab open on a DCS-linked project +
   resource lookup: no client requests to non-`aquilla.app` hosts for content;
   DCS import/live-refresh still works; caching headers pass through.
