# @aquilla/login

Standalone login app for Aquilla (AD-11). Mounted at `/login/*` per
`routes.json`.

Single React route. On submit:

1. POSTs `username` + `password` to `${VITE_AUTH_BASE}/api/v2/auth/token`
   via `@aquilla/auth-client`.
2. On success, writes the JWT to a parent-domain cookie (`aquilla_jwt`)
   and hard-navigates to either `?return=<same-origin>` or `/projects`.
3. On failure, surfaces the server's error message via `AuthClientError`.

## Layout

```
apps/login/
├── index.html              # Vite entry
├── vite.config.ts          # base: '/login/'
├── wrangler.toml           # Cloudflare Worker config (Workers Assets binding)
├── src/
│   ├── main.tsx            # React root (BrowserRouter basename="/login")
│   ├── App.tsx             # The form
│   ├── redirect.ts         # Same-origin ?return= URL sanitizer
│   ├── worker.ts           # CF Worker entry — serves env.ASSETS + adds CSP
│   └── __tests__/
└── README.md
```

## Local dev

```bash
pnpm i
pnpm --filter @aquilla/login dev
# → http://localhost:5173/login/
```

## Build + deploy

```bash
pnpm --filter @aquilla/login build               # Vite → dist/
pnpm --filter @aquilla/login deploy              # wrangler deploy (top-level)
pnpm --filter @aquilla/login deploy:staging      # --env staging
pnpm --filter @aquilla/login deploy:preview      # --env preview (CI substitutes __PR__)
```

## Tests

```bash
pnpm --filter @aquilla/login test
```

Renders the form, mocks `login()`, asserts both happy and error paths.
