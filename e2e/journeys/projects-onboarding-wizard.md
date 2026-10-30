# Create an account and enter the app directly

Smoke twin: `e2e/specs/projects/onboarding.smoke.spec.ts`

AQU-2300 retires the eight-step onboarding wizard. The filename and old URL are retained for compatibility with journey selectors and marketing links.

## Preconditions

- Signed out in an isolated test browser.
- A unique test username and email.

## Steps

1. Open `/onboarding` (or `/signup`). The heading is **Create an Aquilla Account** immediately; there is no welcome screen or **Skip for now**.
2. Fill **Username**, **Email**, and **Password**, then click **Create account**. This is real registration, not a fixture response.
3. Wait for `/orgs/...` and the signed-in account menu.
4. Reload and verify the account menu and app destination remain available.

## Expected end state

The new account is signed in and can use the app. No wizard, workspace creation, project creation, or anonymous completion is required. Workspace/project creation and Preferences remain available inside the app.

## Counts as a failure

- Registration errors or stalls.
- Signup advances into a wizard or exposes an anonymous skip action.
- Reload loses the session or returns to registration.
