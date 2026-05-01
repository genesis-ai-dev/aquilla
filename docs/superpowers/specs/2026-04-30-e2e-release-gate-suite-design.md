# E2E Release-Gate Suite — Design

**Date:** 2026-04-30
**Status:** Proposed
**Owner:** ryderwishart

## Goal

A Playwright-based end-to-end suite that, when green, gives sufficient confidence to hand a build to QA. The suite must:

1. Cover the bulk of user journeys QA would otherwise validate manually (B-minus-snapshots scope — see "Coverage" below).
2. Run hermetically against a real local copy of `frontier-server` and the y-partyserver sync worker (no shared `api.frontierrnd.com` dependency).
3. Run on the developer's machine as a pre-push gate (`@smoke` subset, <2 min budget) and as a full-suite manual pre-release run (<15 min budget).
4. Cover the desktop shell separately via `tauri-driver` against a built `.app`.
5. Be discoverable enough that AI coding assistants extend the suite as part of feature work, without prompting.

## Non-goals

- Replacing manual QA entirely. QA still owns exploratory testing, perceptual review, accessibility audits, and any uncovered journey listed in `e2e/JOURNEYS.md`.
- Snapshot/diff testing of the editor state. Snapshots are being redesigned; the journey will be added once the redesign lands.
- Cross-browser coverage. Chromium only for v1; Firefox/Safari deferred until a real cross-browser bug forces the issue.
- GitHub Actions CI in v1. The suite must be CI-runnable but the wiring is out of scope here. Pre-push on the developer's machine is the immediate execution surface.

## Coverage (B minus snapshots)

Each journey gets at least one spec. Helpers/page-objects are shared across journeys.

| Area | Journey | Spec |
|---|---|---|
| Auth | Sign up new account | `specs/auth/signup.spec.ts` |
| Auth | Log in existing account | `specs/auth/login.spec.ts` |
| Auth | Password reset request | `specs/auth/password-reset.spec.ts` |
| Auth | Switch between two signed-in accounts | `specs/auth/account-switch.spec.ts` |
| Onboarding | First-run flow to dashboard | `specs/onboarding/flow.spec.ts` |
| Projects | Create / open / delete | `specs/projects/crud.spec.ts` |
| Projects | Trash → restore / permanent delete | `specs/projects/trash.spec.ts` |
| Orgs | Create org | `specs/orgs/create.spec.ts` |
| Orgs | Add / remove members | `specs/orgs/members.spec.ts` |
| Orgs | Change member role | `specs/orgs/roles.spec.ts` |
| Orgs | Send & accept invite | `specs/orgs/invites.spec.ts` |
| Editor | Import markdown / USFM | `specs/editor/import.spec.ts` |
| Editor | Cell edit persists across reload + virtualization | `specs/editor/edit-persist.spec.ts` |
| Editor | Cmd+K search | `specs/editor/search.spec.ts` |
| Editor | Virtualized scroll integrity | `specs/editor/virtualization.spec.ts` |
| Rules | Define a rule | `specs/rules/define.spec.ts` |
| Rules | See violation surface in editor | `specs/rules/violations.spec.ts` |
| Rules | Auto-correct a violation | `specs/rules/auto-correct.spec.ts` |
| Validation | Validate a cell, icon changes | `specs/validation/validate.spec.ts` |
| Validation | History persists across navigation | `specs/validation/history.spec.ts` |
| AI | Sparkle button fills cell from mock LLM | `specs/ai/completion.spec.ts` |
| Collab | New file appears in second browser | `specs/collab/file-propagation.spec.ts` |
| Collab | Two users edit different cells, both see updates | `specs/collab/concurrent-edit.spec.ts` |
| Collab | Two users edit same cell, conflict resolves | `specs/collab/conflict.spec.ts` |
| Collab | Member presence indicators | `specs/collab/member-presence.spec.ts` |
| Comments | Add / edit / resolve comment | `specs/comments/add-edit-resolve.spec.ts` |
| Sharing | Generate invite link | `specs/sharing/invite-link.spec.ts` |
| Sharing | Join project via link | `specs/sharing/join-flow.spec.ts` |
| Audio/Video | Import audio file | `specs/audio-video/import.spec.ts` |
| Audio/Video | Subtitles flow | `specs/audio-video/subtitles.spec.ts` |
| Settings | Edit setting in browser A → propagates to B | `specs/settings/sync.spec.ts` |
| Settings | Settings persist across reload | `specs/settings/persistence.spec.ts` |
| Export | Export to each supported format | `specs/export/export-formats.spec.ts` |
| Tauri | Native dialog, deeplink, updater handshake, fs bridge, keychain | `tauri/smoke.spec.ts` |

Excluded from v1 (to be tracked in `e2e/JOURNEYS.md` as gaps):
- Snapshots (under redesign).

## Architecture

### Directory layout

```
e2e/
  config/
    playwright.config.web.ts          # primary suite, Chromium against Vite (port 5173)
    playwright.config.tauri.ts        # tauri-driver against built .app
  fixtures/                           # sample.md, sample.usfm, sample.mp3, sample.mp4
  helpers/
    workers.ts                        # boots wrangler dev for frontier-server + partyserver
    seed.ts                           # resets local D1, creates known users
    auth.ts                           # signIn(page, user), persisted storageState per user
    page-objects/
      Dashboard.ts
      Workspace.ts
      OrgsPage.ts
      RulesPanel.ts
      Settings.ts
    multi-user.ts                     # test fixture exposing { alice, bob, carol } pre-auth'd Pages
    mock-llm-server.ts                # moved from current location
  specs/                              # one folder per area, see Coverage table
  tauri/
    smoke.spec.ts
  JOURNEYS.md                         # canonical user-journey → spec map
  README.md                           # how to run, how to add a test
scripts/
  e2e-up.ts                           # boots backends, seeds, hands off to Playwright
  e2e-seed.ts                         # invoked between tests via /__test__/reset
  e2e-down.ts                         # cleanup
.husky/
  pre-push                            # runs npm run test:e2e:smoke
AGENTS.md                             # repo-root rules for AI coders (new file)
```

### Backend orchestration (`scripts/e2e-up.ts`)

A single Node entrypoint:

1. Resolve `FRONTIER_SERVER_DIR` env (default `~/frontierrnd/frontier-server/cloudflare`). Hard-fail with a clear message if absent.
2. Wipe `${FRONTIER_SERVER_DIR}/.wrangler/state/v3/d1/<frontier-db-v2>.sqlite`.
3. Run `wrangler d1 migrations apply frontier-db-v2 --local` from `FRONTIER_SERVER_DIR`.
4. Boot `frontier-server` via `wrangler dev --local --port 8787` (background, child process).
5. Resolve `PARTYSERVER_DIR` (default `${repo}/sync-worker`) and boot via `wrangler dev --local --port 8788`.
6. Boot `MockLLMServer` (existing class, on a random port).
7. Wait for all three to be reachable (poll health endpoints, timeout 30s).
8. Write `.env.test.local` with `VITE_FRONTIER_BASE`, `VITE_SYNC_WORKER_HOST`, `VITE_LLM_BASE_URL`.
9. Spawn Playwright with that env (`playwright test --config e2e/config/playwright.config.web.ts`).
10. On exit (success or fail), tear down children.

`scripts/e2e-down.ts` is the manual cleanup if anything is orphaned.

### Per-test reset

Frontier-server gains a test-only route `POST /__test__/reset` gated behind `WRANGLER_LOCAL=1`. It:

- Truncates user/org/project/membership tables.
- Re-seeds three known users: `alice`, `bob`, `carol` (passwords stored in `.env.test.local`).
- Re-seeds one known org `Acme` owned by `alice`.

Playwright `beforeEach` calls this route before any test logic. ~50ms per test, hermetic.

Y-partyserver state is project-scoped (one Durable Object per project). Each test creates fresh project IDs, so DO state is naturally isolated. No reset needed for partyserver.

### Multi-user fixture (`e2e/helpers/multi-user.ts`)

```ts
import { test as base, expect, type BrowserContext, type Page } from "@playwright/test"

type AuthedPage = Page & { username: string; logout: () => Promise<void> }

export const test = base.extend<{ alice: AuthedPage; bob: AuthedPage; carol: AuthedPage }>({
  alice: async ({ browser }, use) => use(await authedPage(browser, "alice")),
  bob:   async ({ browser }, use) => use(await authedPage(browser, "bob")),
  carol: async ({ browser }, use) => use(await authedPage(browser, "carol")),
})

async function authedPage(browser: Browser, username: string): Promise<AuthedPage> {
  const ctx = await browser.newContext({ storageState: `e2e/.auth/${username}.json` })
  const page = await ctx.newPage()
  // storageState was written by global setup once per suite from a real login
  return Object.assign(page, { username, logout: () => signOut(page) })
}

export { expect }
```

Specs that need 2+ users import `test` from this module:

```ts
import { test, expect } from "../../helpers/multi-user"
test("collab: edits propagate", async ({ alice, bob }) => { /* ... */ })
```

Specs that need only one user import the standard `test` from `@playwright/test` and use a `signIn` helper directly.

### Page objects

Each surface gets a class with explicit methods. Selectors live only inside the class.

```ts
// e2e/helpers/page-objects/Workspace.ts
export class Workspace {
  constructor(private page: Page) {}
  async importFile(path: string) { /* clicks Import, uploads, waits for dialog close */ }
  async openFile(name: string) { /* clicks file row in sidebar */ }
  async editCell(cellId: string, text: string) { /* clicks cell, types, blurs */ }
  cell(cellId: string) { return this.page.locator(`[data-cell-id="${cellId}"]`) }
  async validateCell(cellId: string) { /* clicks validation button, confirms */ }
}
```

Existing `e2e/helpers.ts` is migrated into the page-object structure; the loose helper functions become methods on appropriate classes (`Dashboard.createProject`, `Workspace.importFile`, etc.).

### Pre-req code change

`FRONTIER_BASE` in [src/lib/frontier/auth.ts](src/lib/frontier/auth.ts:4) becomes:

```ts
export const FRONTIER_BASE = (import.meta.env.VITE_FRONTIER_BASE as string | undefined) ?? "https://api.frontierrnd.com"
```

A grep pass identifies any other hard-coded backend URLs (sync worker host, LLM endpoint defaults) and applies the same `import.meta.env.*` override pattern. Production builds keep their current values via the `??` fallback.

## Test classification

Tags via Playwright `test.describe.configure({ tag: "@smoke" })` or filename suffix `.smoke.spec.ts`. Approach: filename suffix — explicit, greppable, no easy way to forget.

- `*.smoke.spec.ts` — pre-push gate. ~25-30 specs covering: login, create project, import file, edit cell persists, AI completion (mock), validate cell, two-user edit propagation, add member to org, define rule + see violation. Total budget <2 min.
- `*.spec.ts` — full suite, manual pre-release. <15 min.
- `tauri/*.spec.ts` — separate runner, manual pre-release.

Smoke is the strict subset: every smoke spec is also a full-suite spec.

## Pre-push wiring

```bash
# .husky/pre-push
#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

npm run test:e2e:smoke || {
  echo ""
  echo "❌ E2E smoke failed. Push blocked."
  echo "   Run \`npm run test:e2e:ui\` to debug, or \`git push --no-verify\` to bypass (not recommended)."
  exit 1
}
```

`package.json`:

```json
"scripts": {
  "test:e2e:smoke": "tsx scripts/e2e-up.ts -- --grep '\\.smoke\\.spec\\.ts'",
  "test:e2e": "tsx scripts/e2e-up.ts",
  "test:e2e:ui": "tsx scripts/e2e-up.ts -- --ui",
  "test:e2e:tauri": "playwright test --config e2e/config/playwright.config.tauri.ts",
  "prepare": "husky"
}
```

## AI discoverability

Three reinforcing layers.

### 1. `AGENTS.md` at repo root

Read by Claude Code, Cursor, Copilot, Aider, and other agents. Contains a "Testing — non-negotiable" section:

```md
## Testing — non-negotiable

Before claiming any feature is complete:
1. Run `npm run test:e2e:smoke`. It must pass.
2. If your change touches a journey listed in `e2e/JOURNEYS.md`, extend the matching spec OR add a new spec under `e2e/specs/<area>/`.
3. New user-facing journey = new row in `e2e/JOURNEYS.md` AND a new spec.
4. Reuse helpers in `e2e/helpers/page-objects/`. Do not duplicate selectors.
5. Tests run against a local `wrangler dev` instance of `frontier-server`, not the production backend. See `e2e/README.md` for setup.
```

### 2. `e2e/JOURNEYS.md` — canonical journey map

Markdown table of every journey → spec file → owner. Format identical to the Coverage table above. AI coders grep this by keyword to find the spec to extend; if no match, that's the signal to add a row + a new spec.

### 3. Pre-push hook + slash command

- `.husky/pre-push` runs `npm run test:e2e:smoke`. Failure feedback is fast and unmissable.
- `.claude/commands/e2e-add.md` — slash command that scaffolds a new spec from a template, prompts for journey name, area, and required fixtures, and adds a row to `JOURNEYS.md`.

## Acceptance criteria

The framework is "done" when:

- [ ] `npm run test:e2e:smoke` runs end-to-end on a clean macOS dev machine in <2 min, all green.
- [ ] `npm run test:e2e` runs the full B-minus-snapshots suite in <15 min on the same machine.
- [ ] `npm run test:e2e:tauri` runs the native shell suite against a built `.app`.
- [ ] `git push` is blocked when smoke fails.
- [ ] `AGENTS.md` and `e2e/JOURNEYS.md` exist and an AI agent reading them can locate the right spec for an arbitrary feature without exploration.
- [ ] A failing test produces: trace.zip, screenshot, video on retry. The trace clearly shows which `wrangler dev` worker was hit.
- [ ] Multi-user fixture works: a single test can drive `alice` and `bob` Pages in parallel and assertions can target each independently.
- [ ] Per-test reset is verified: running any spec alone produces the same result as running it in suite context.

## Risks & mitigations

- **`frontier-server` checkout drift.** A spec that depends on a server route that hasn't shipped yet will fail. Mitigation: `e2e-up.ts` records the `frontier-server` git SHA at boot and emits it in test reports. PR descriptions reference both SHAs when the contract changes.
- **Wrangler cold-start latency.** `wrangler dev` takes 5-15s to boot. Mitigation: orchestrator boots once for the whole suite, not per-test. Per-test reset is the `/__test__/reset` route, not a worker restart.
- **Tauri-driver fragility.** Native automation drivers are historically flaky. Mitigation: the Tauri suite is small, manual, and not a push gate. If it goes red repeatedly without a real bug, we mark specs `.skip` and triage rather than blocking releases.
- **Mock LLM divergence from real provider behavior.** The mock could pass while a real provider regresses. Mitigation: the mock asserts on outgoing request shape (existing `requests` array). A separate "real LLM" smoke can be added later in nightly only.
- **AI coders ignoring AGENTS.md.** Mitigation: pre-push hook is the hard enforcement. AGENTS.md is the soft guidance. The hook runs whether or not the agent read the doc.

## Open questions (resolve during implementation)

- Exact selector strategy for cells (CSS attr vs. role) — confirm with current `data-cell-id` usage during implementation.
- Whether `e2e/.auth/*.json` storageState files are gitignored or committed. Decision: gitignored, regenerated by global setup on each suite run.
- Final list of `*.smoke.spec.ts` files — start with proposed set (login, project create, file import, cell edit persists, AI completion, validate cell, two-user edit propagation, add member to org, define rule + see violation), tune to fit the 2-min budget during implementation.
