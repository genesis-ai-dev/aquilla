---
name: verify-dev-change
description: Verify a code change in the codex-web-app SPA by driving the local dev stack as the seeded dev user. Use when you've made a UI/behavioural change and need to confirm it works before claiming "done" — instead of asking the user to "reload and click X." Triggers on requests to verify, sanity-check, smoke-test, confirm a fix works, or check that a feature behaves correctly in the browser. Also fires automatically before declaring frontend work complete in this workspace.
---

# Verifying a code change in codex-web-app

This skill replaces the anti-pattern of "on your side: reload and click X" with the agent actually driving the app. It works because the workspace has a seeded dev backend + an auto-login URL + Playwright MCP.

## When to use

- You changed a React component, hook, or route and need to see it render correctly.
- You fixed a bug and need to confirm the failing flow now succeeds.
- You're about to claim a feature is "complete," "done," "shipped," or "passing."
- You changed sync/auth/workspace logic and want to confirm it doesn't break the basic logged-in load.

## When NOT to use

- Pure backend changes with their own tests (run the test instead).
- Multi-user collab scenarios → use the e2e harness (`e2e/helpers/multi-user.ts`).
- Bugs that only reproduce against real production data shapes → escalate to the user with a clear repro request.
- Changes that depend on the user's existing IDB state (corrupt outbox, partial sync, etc.) → ask them.

## The loop

### 1. Confirm Playwright MCP is connected

You need tools named `mcp__plugin_playwright_playwright__browser_*`. If they're not in your tool list, `ToolSearch` for "playwright" — they may be deferred. If they're genuinely unavailable, stop and tell the user; do not fall back to "please verify on your end."

### 2. Confirm the dev stack is up

`curl -sf http://127.0.0.1:5173/ > /dev/null && curl -sf http://127.0.0.1:8788/healthz > /dev/null`

If either fails, start it: run `pnpm dev` in the background (`run_in_background: true` on the Bash tool) and wait until both ports respond. Do NOT block your turn on `pnpm dev` in the foreground.

### 3. Land in a logged-in session

```
browser_navigate http://127.0.0.1:5173/__dev/login
```

This route:
- calls `POST /__dev__/login` on auth-worker,
- writes the session to IDB,
- redirects to `/project/dev-project`.

If it sits on the "Signing in as dev…" screen, check the error message. The most common cause is `auth-worker` not running with `WRANGLER_LOCAL=1` — `pnpm dev` sets it; bare `wrangler dev` does not.

### 4. Navigate to the change

Use `browser_navigate` to reach the route your change touches. For project-scoped surfaces the project id is `dev-project`:

- Workspace: `/project/dev-project`
- Project settings: `/project/dev-project/settings`
- Members: `/members`
- Voice studio: `/project/dev-project/voice`
- Comments: `/project/dev-project/comments`

### 5. Interact and observe

- `browser_snapshot` gives you the accessibility tree — usually enough to confirm a component rendered with the right text/role.
- `browser_take_screenshot` when the change is visual (layout, colour, spacing).
- `browser_click`, `browser_type`, `browser_fill_form` to exercise the change.
- `browser_console_messages` to catch runtime errors. Always check this after any interaction — a green snapshot with a red console is still broken.
- `browser_network_requests` when the change is about request shape, deduping, or auth headers.

### 6. State your finding with evidence

After verifying, your summary must reference what you actually saw — the snapshot output, the screenshot, the network request. NOT "typecheck passed and the unit tests still pass, so it should work." That's not verification.

If verification failed, debug the failure before reporting. Do not hand a broken state back to the user as "the implementation is done, you can confirm it."

## Seeded data summary

(From `auth-worker/src/routes/dev-seed.ts` — see that file for the full list.)

| Entity   | Identifier     | Notes                          |
| -------- | -------------- | ------------------------------ |
| User     | `dev`          | Password `dev`, OWNER of all   |
| Org      | `Dev Org`      | dev user is owner              |
| Project  | `dev-project`  | TEXT id; usable in URL path    |

The seed has no files or cells. If your change needs those, either:
- create them via the UI as part of the verification flow,
- extend the seed in `dev-seed.ts` (idempotent upserts only — don't break existing tests).

## Failure modes to recognise

- `/__dev/login` route 404s → the SPA build is stale; restart `pnpm dev`.
- `/__dev__/login` (worker) 404s → `WRANGLER_LOCAL=1` not reaching auth-worker. `pnpm dev` sets it; a raw `wrangler dev` invocation does not.
- "session not found" after navigate → IDB write happened on a different origin than navigate; ensure you stay on `127.0.0.1:5173` (not `localhost`).
- Browser shows the onboarding wizard instead of the project → the redirect after dev-login didn't fire; navigate manually to `/project/dev-project`.

## Relationship to other skills

- `verify` (root global): the generic "drive the app" skill — this one is the codex-web-app specialisation.
- `superpowers:verification-before-completion`: the discipline ("evidence before assertions"). This skill is HOW you produce that evidence in this repo.
- `tdd`: tests-first for new behaviour. This skill is for confirming the behaviour shows up in the actual browser, which tests alone don't prove.
