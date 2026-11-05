# Account-owned analytics network verification

This suite uses only the synthetic E2E database and a local collector. It is
separate from the ordinary smoke suite because it requires an analytics-enabled
build; running the assertions with no SDK key would be a false pass.

Start the hermetic stack:

```sh
VITE_POSTHOG_KEY=phc_local_privacy_test VITE_POSTHOG_HOST=http://127.0.0.1:9999 E2E_VITE_MODE=dev E2E_SERVE_ONLY=1 pnpm exec tsx scripts/e2e-up.ts
```

Then run:

```sh
VITE_FRONTIER_BASE=http://127.0.0.1:9787 pnpm exec playwright test --config=e2e/config/playwright.config.privacy.ts
```

The collector is started by Playwright. The suite requires positive approved
captures as well as zero pre-approval/other-account captures. Browser automation
markers are hidden solely to exercise the SDK's actual transport rather than
its bot filter. Application consent checks and transport are not mocked.
Seed login and account insertion use the existing test helpers; account switching
uses the actual menu. Direct controller calls isolate consent state transitions;
the onboarding smoke suite separately drives the signup and settings UI paths.
WebKit coverage is engine coverage, not a claim of native Safari verification.
