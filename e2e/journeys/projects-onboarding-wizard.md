# Welcome, choose usage sharing, and create an account

Smoke twin: `e2e/specs/projects/onboarding.smoke.spec.ts`

AQU-2300 reduces the eight-step onboarding wizard to three screens. The filename and old URL are retained for compatibility with journey selectors and marketing links.

## Preconditions

- Signed out in an isolated test browser.
- A unique test username and email.

## Steps

1. Open `/onboarding` (or `/signup`). On Welcome, choose **Get Started**, then on Help us improve choose whether to share usage data and **Continue**. Sharing defaults off. A previously saved choice skips this privacy screen. Welcome also offers **Sign in** for existing accounts.
2. Fill **Username**, **Email**, and **Password**, then click **Create account**. This is real registration, not a fixture response.
3. Wait for `/orgs/...` and the signed-in account menu.
4. Reload and verify the account menu and app destination remain available.

## Expected end state

The new account is signed in and can use the app. No workspace/project setup or anonymous completion is required. Workspace/project creation and Preferences remain available inside the app.

## Counts as a failure

- Registration errors or stalls.
- Signup advances past account creation into workspace/project setup or exposes an anonymous skip action.
- Reload loses the session or returns to registration.
