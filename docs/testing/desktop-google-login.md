# Desktop Google login (AQU-2640)

The desktop app opens Google's authorization page in the system browser. Google
returns to the existing registered HTTPS identity-worker callback. That worker
returns a one-use, five-minute code to `aquilla://auth/google`; the desktop
window must match its pending challenge and redeem the code with its private
PKCE verifier. The link never carries an access token, refresh token or password.
No new Google Cloud redirect registration, client secret, or database migration
is required.

A compatible desktop shell **and** identity worker are required. Older shells or
workers keep Google disabled with explanatory guidance. Web login is unchanged.
CI previews continue to disable Google. Do not publish or deploy this branch to
production as part of verification.

## Automated verification

Use Node 24 for the native WebDriver runner; its Undici dependency needs the newer zstd API.

- `pnpm exec vitest run src/lib/frontier/google-login.test.ts src/components/auth/GoogleLoginButton.test.tsx src/pages/GoogleLoginReturn.test.tsx`
- `pnpm --dir auth-worker exec vitest run src/__tests__/oauth-google.test.ts`
- `cargo test --manifest-path src-tauri/Cargo.toml --lib auth::tests`
- `E2E_CONFIG=e2e/config/playwright.config.google-login.ts pnpm exec tsx scripts/e2e-up.ts -- e2e/specs/auth/google-login.spec.ts`
- `pnpm tauri:build:e2e && pnpm test:e2e:tauri`

The worker suite uses signed simulated provider claims and real Postgres
semantics; it passes the generated native link through the production desktop
parser. The native smoke uses the real Rust callback handler and JavaScript
listener. It tests cancellation and rejection of credential-bearing links.
Neither test claims a live Google authorization.

Native smoke builds use `app.aquilla.e2e`, separate from the installed app's
saved data, and local backend URLs. Do not distribute the WebDriver-enabled
binary to users.

## Human trial on development

First release the reviewed backend change to development through the normal
`dev` branch deployment gate. Build a desktop test application with
`VITE_AUTH_BASE=https://api.dev.aquilla.app/identity` and the development sync
endpoint. Use a separate application identifier/data directory. Install/launch
the test app so the operating system can deliver its `aquilla://` callback;
make sure the callback opens that build rather than an older installed copy.

1. Click **Continue with Google**. The system browser opens and the app displays
   a waiting message with **Cancel**.
2. Choose an allowed development Google test account. Confirm the OS prompt to
   return to Aquilla, if shown. Confirm the correct account and intended page.
3. Repeat but cancel in Google; no account should be adopted.
4. Repeat but cancel in Aquilla before completing Google; the late callback must
   not sign in. Start a fresh attempt and confirm it works.
5. Try a different Google account intentionally. Existing account proof/signup
   screens must still apply; no account is linked merely by email match.
6. Close the app during an attempt. On restart, an orphaned callback must not
   sign in without the original local proof. Start again.

Keep AQU-2607 on hold. This work changes no database driver or pool settings.
