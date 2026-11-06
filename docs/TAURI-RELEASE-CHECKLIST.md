# Tauri desktop shell — release checklist

Status: the TS/Rust integration and the release workflow are in place
(`.github/workflows/tauri-release.yml`, triggered by any `v*` tag). What is
**not** done is the one-time signing and updater setup — `src-tauri/tauri.conf.json`
still carries placeholders, so a `v*` tag today produces an unsigned bundle with
a non-functional updater:

| Placeholder in `src-tauri/tauri.conf.json` | Needs |
| --- | --- |
| `plugins.updater.pubkey` → `REPLACE_WITH_OUTPUT_OF_npx_tauri_signer_generate` | the updater public key |
| `bundle.macOS.signingIdentity` → `null` | the Developer ID identity |
| `bundle.macOS.providerShortName` → `null` | the Apple team ID |

The shell ships as `Aquilla` (`productName`), identifier `com.frontierrnd.aquilla`.
The web bundle inside it updates hourly on its own channel — see the "Desktop"
section of [`DEPLOYMENT-ENVIRONMENTS.md`](DEPLOYMENT-ENVIRONMENTS.md).

## Smoke tests (do anytime — no signing required)

### Unsigned CI build

The `tauri-build` workflow (Actions → tauri-build → Run workflow; also runs on
PRs touching `src-tauri/**`) builds every release target without signing
secrets and uploads the installers as artifacts, plus the Tauri smoke suite.
Run it before tagging. Its macOS builds are ad-hoc signed, not notarized:
`xattr -dr com.apple.quarantine /Applications/Aquilla.app` before first launch.

`src-tauri/tauri.unsigned.conf.json` (this workflow, and the release's e2e
build) and `src-tauri/tauri.release.conf.json` (the signed release) both blank
`beforeBuildCommand`, so the bundle packages the hosted `dist/` the workflow
built with production hosts. The release config also turns on
`createUpdaterArtifacts`; without it Tauri v2 writes no `.sig` files and no
`latest.json`, and installed apps never update.

### Debug bundle launches

```bash
pnpm tauri:build -- --debug
open src-tauri/target/debug/bundle/macos/Aquilla.app
```

Expected: the same window as `pnpm tauri:dev`, but loading the production Vite
build. If it crashes on launch, check Console.app for the signature.

### End-to-end Rust IPC round-trip

In a `pnpm tauri:dev` window:

1. Sign in with Frontier creds
2. Import a small git repo
3. Open it, edit a cell, sync
4. Confirm the edit round-trips (re-pull, see your change)

The data lives at `~/Library/Application Support/com.frontierrnd.aquilla/repos/` —
`ls` it to confirm `.git/` and a working tree are there. Watch the Rust process
stdout for any `EIO`/`ENOENT`/`EINVAL` from the fs bridge.

## Release checklist (when ready to sign + ship)

### One-time setup

1. **Generate the updater signing keypair** (separate from the code-signing certs)

   ```bash
   npx tauri signer generate -w ~/.tauri/aquilla-updater.key
   ```

   Save the private key + password in 1Password.

2. **Fill the placeholders in `src-tauri/tauri.conf.json`** — the rows in
   the table above. Match `signingIdentity` to an entry from
   `security find-identity -v -p codesigning`.

3. **Add the GitHub repo secrets** (Settings → Secrets and variables → Actions).
   The authoritative list is the `env:` block of the `tauri-apps/tauri-action`
   step in `.github/workflows/tauri-release.yml`:
   `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`,
   `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
   `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD`,
   `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, plus
   `AQUILLA_BUNDLE_PUBKEY` (hot-bundle verification key, from
   `pnpm desktop:bundle:keygen`; the workflow fails without it).
   Reuse the existing certs from the other apps.

   ⚠ Any push of a `v*` tag reaches this job and these secrets, and the job
   builds and runs the tagged commit's own code — see the comment at the top of
   the workflow before granting tag-push rights.

### Cut a release

```bash
git tag v0.1.0
git push origin v0.1.0
```

The `tauri-release` workflow runs across macOS arm64 + x86_64, Windows and
Linux, and drafts a GitHub release with the platform bundles and `latest.json`.
Promote it to published from the GitHub UI.

This is the **desktop shell's** own tag series (`v*`) and is independent of the
web app's calver release tags (`YYYY.MM.DD.NN`, see
[`DEPLOYMENT-ENVIRONMENTS.md`](DEPLOYMENT-ENVIRONMENTS.md)).

### Verify auto-update

Bump the version to `0.1.1` in `src-tauri/tauri.conf.json` + `package.json`,
push tag `v0.1.1`. The running v0.1.0 install should detect the update on next
launch.

## Known follow-ups (non-blocking)

- `fs_readdir` (`src-tauri/src/fs_bridge.rs`) silently drops non-UTF-8
  filenames (rare in our content but lossy).
- Bytes pass over IPC as `number[]`. Fine for now; revisit if clone perf hurts
  on large repos.
- Consider switching from `isomorphic-git` to native git (gitoxide / libgit2)
  once the FsProvider layer has shipped — would handle LFS natively. Out of
  scope for v0.1.

Resolved since this checklist was written: `safe_join`
(`src-tauri/src/repo_root.rs`) now rejects segments containing `\`, `:` or NUL
outright, so the Windows-backslash concern no longer rests on the lexical
`starts_with(root)` guard alone.
