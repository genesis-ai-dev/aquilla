# TODO — Tauri desktop shell

The TS/Rust integration and CI workflows are in place. Remaining work — pick up when ready to release.

## Smoke tests (do anytime — no signing required)

### Debug bundle launches

```bash
cd .worktrees/tauri-desktop-shell
npm run tauri:build -- --debug
open src-tauri/target/debug/bundle/macos/Codex.app
```

Expected: same window as `npm run tauri:dev`, but loading the production Vite build. If it crashes on launch, check Console.app for the signature.

### End-to-end Rust IPC round-trip

In a `npm run tauri:dev` window:
1. Sign in with Frontier creds
2. Import a small git repo
3. Open it, edit a cell, sync
4. Confirm the edit round-trips (re-pull, see your change)

The data lives at `~/Library/Application Support/com.frontierrnd.codex/repos/` — `ls` it to confirm `.git/` and a working tree are there. Watch the Rust process stdout for any `EIO`/`ENOENT`/`EINVAL` from the fs bridge.

## Release checklist (when ready to sign + ship)

### One-time setup

1. **Generate updater signing keypair** (separate from the code-signing certs)
   ```bash
   npx tauri signer generate -w ~/.tauri/codex-updater.key
   ```
   Save the private key + password in 1Password.

2. **Fill placeholders in `src-tauri/tauri.conf.json`**
   - `plugins.updater.pubkey` — paste the public key from step 1
   - `plugins.updater.endpoints[0]` — replace `REPLACE_ORG` with the actual GitHub org/user
   - `bundle.macOS.signingIdentity` — set to `"Developer ID Application: <Name> (TEAMID)"` (match `security find-identity -v -p codesigning`)
   - `bundle.macOS.providerShortName` — set to the team ID

3. **Add GitHub repo secrets** (Settings → Secrets and variables → Actions)
   See the list in `docs/SPEC.md` under "Release secrets". Reuse the existing certs from the other apps.

### Cut a release

```bash
git tag v0.1.0
git push origin v0.1.0
```

The `tauri-release` workflow runs across macOS arm64 + x86_64, Windows, Linux. Drafts a GitHub release with `.dmg`, `.msi`, `.AppImage`, and `latest.json`. Promote to published from the GitHub UI.

### Verify auto-update

Bump version to `0.1.1` in `src-tauri/tauri.conf.json` + `package.json`, push tag `v0.1.1`. The running v0.1.0 install should detect the update on next launch.

## Known follow-ups (non-blocking)

- `safe_join` in `src-tauri/src/repo_root.rs` splits on `/` only — Windows backslash segments rely on the lexical `starts_with(root)` guard. Not exploitable on macOS/Linux. Tighten before targeting Windows seriously.
- `fs_readdir` silently drops non-UTF-8 filenames (rare in our content but lossy).
- Bytes pass over IPC as `number[]`. Fine for now; revisit if clone perf hurts on large repos.
- Consider switching from `isomorphic-git` to native git (gitoxide / libgit2) once the FsProvider layer has shipped — would handle LFS natively. Out of scope for v0.1.
