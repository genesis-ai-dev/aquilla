# @aquilla/projects

Project list + project lifecycle app. Mounted at `/projects/*`.

Per AD-11 / spec §21: discrete app, one task per page (list, create,
settings, onboarding, invite-acceptance). The workspace SPA owns
continuous translation state at `/w/*`.

## Routes

| Path                   | Component               | Status     |
|------------------------|-------------------------|------------|
| `/`                    | `ProjectListPage`       | Phase 3c (cloud list via api-client) |
| `/new`                 | `ProjectCreatePage`     | stub — Phase 5 lands shape picker (AD-9) |
| `/:id/settings`        | `ProjectSettingsPage`   | stub — Phase 3a relocates hooks; Phase 5 adds source-linking panel |
| `/onboarding`          | `OnboardingPage`        | stub — Phase 3a relocates onboarding deps |
| `/join/:token`         | `JoinPage`              | Phase 3c (preview + accept via api-client) |

## Dev

```bash
pnpm --filter @aquilla/projects dev    # vite on :5174
pnpm --filter @aquilla/projects build
pnpm --filter @aquilla/projects test
```

## Deploy

```bash
pnpm --filter @aquilla/projects deploy:staging
pnpm --filter @aquilla/projects deploy            # production
```

CI substitutes `__PR__` in wrangler.toml's `[env.preview]` and deploys per
PR to `pr-<N>.aquilla.app/projects/*`.

## Dependencies

- `@aquilla/api-client` — typed fetch wrappers (`fetchProjectList`,
  `fetchProject`, invite primitives)
- `@aquilla/auth-client` — parent-domain JWT cookie reader
- `@aquilla/ui` — shared shadcn primitives (Card, Skeleton, Button)
- `@aquilla/errors` — boot-time `assertEnvBindings` + `assertNotPreviewInProd`
