# Desktop hot bundle: the web client updates hourly, the shell updates rarely

**Date:** 2026-11-05 · **Status:** implementing on `ryder/desktop-hot-bundle`

## Problem

The Tauri desktop app embeds the web bundle at build time (`frontendDist: ../dist`).
Every web change needs a new signed desktop build, and that pipeline has never run.
Old desktop clients are a major source of support friction. We want desktop users to
run the same build as the web within one launch of each hourly release, with no
desktop-specific branch to maintain.

## What is native vs. web

The Rust side is ~2,100 lines and ~30 IPC commands: filesystem bridge, keychain,
connectivity probe, LLM proxy config, Paratext discovery/watch, updater, shutdown
guard. LiveStore, wa-sqlite, OPFS, the outbox and the reconciler all run inside the
webview. "The desktop app" is the web bundle plus a small, slow-moving native contract.

## Design: two update channels

### 1. Web bundle (hourly, automatic)

The production release line already builds `dist/`. After `tag-release.sh` succeeds,
`scripts/desktop-bundle-publish.ts` also publishes that dist as a hot bundle:

```
<R2 public base>/production/<calver>/bundle.tar.gz
<R2 public base>/production/latest.json
```

`latest.json` (the manifest):

```json
{
  "schema": 1,
  "version": "2026.11.05.03",
  "sha": "<git sha>",
  "url": "https://…/production/2026.11.05.03/bundle.tar.gz",
  "sha256": "<hex of the tarball>",
  "size": 12345678,
  "minShellVersion": "0.2.0",
  "createdAt": "2026-11-05T19:00:00Z",
  "signature": "<base64 ed25519 signature>"
}
```

The signature is ed25519 over the canonical signing string
`schema\nversion\nsha\nurl\nsha256\nsize\nminShellVersion\ncreatedAt` (fields joined by
`\n`, no trailing newline). The private key lives only in the
`DESKTOP_BUNDLE_SIGNING_KEY` repo secret (PKCS#8 PEM). `deploy:aquilla` runs the
publisher with `--preflight` before the SPA build: an unset secret is a warning and the
publish is skipped, while a secret that is set but does not parse as an ed25519 PKCS#8
PEM stops the chain there, before anything reaches production. The public key is
compiled into the shell. `minShellVersion` is the `version` in `src-tauri/tauri.conf.json`
at the commit being released, so bumping the shell version is also what raises the floor.

The shell (`src-tauri/src/hot_bundle.rs`):

- On launch and on every offline→online transition, fetches the manifest (60 s timeout).
- Verifies the signature, compares `version` to the current bundle, and checks
  `minShellVersion <= shell version`. A too-old shell does not download; it emits
  `bundle://shell-outdated` so the SPA nudges the user to the shell updater.
- Downloads to `<app data>/bundles/staging/<version>/`, verifies `sha256`, extracts,
  requires `index.html`, then renames to `<app data>/bundles/<version>/` and writes
  `<app data>/bundles/staged` → `<version>`. Emits `bundle://staged`.
- On the next launch, before the window is created: if `staged` exists, move the
  current pointer to `previous`, make `staged` the `current`, and write a `pending`
  marker. Serve from `current`. If no `current`, serve the embedded assets.
- The SPA calls `bundle_booted` once mounted. The shell clears `pending`.
- If a launch finds `pending` still set from the last run, that bundle never booted:
  roll back to `previous`, record the version in `quarantine.json` so it is never
  re-downloaded, and emit `bundle://rolled-back`. Keep at most two versions on disk.
- A bundle can be older than the shell (served before the shell update, or restored by
  a rollback). Window behaviour the SPA must cooperate with is turned on only when the
  bundle being served lists it in `shell-features.json`, written by every SPA build
  (`vite.config.ts`); bundles without the file list nothing. The embedded assets always
  qualify. First user: the macOS overlay title bar (`mac-titlebar-overlay`).
- Debug builds honour `AQUILLA_BUNDLE_MANIFEST_URL` to point at a test manifest.
- Release builds with no compiled-in public key never apply remote bundles (log once).

**Origin.** The SPA is always served through a custom URI scheme `app://localhost`
(Windows: `http://app.localhost`), whether from a downloaded bundle or the embedded
assets, so OPFS/IndexedDB and capabilities stay on one origin across every hot update
and shell update. No release has ever shipped, so no data migration is needed.

### 2. Native shell (rare, signed)

The existing Tauri updater (`app_update.rs`, GitHub Releases `latest.json`) stays for
the shell. It ships only when the Rust contract changes. Operational rule: **a change
to any `#[tauri::command]`, IPC event name, or capability bumps `version` in
`src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`.** That version becomes
`minShellVersion` for every bundle published from that commit on.

## Frontend

- `src/lib/offline/bundle-update.ts`: typed wrappers for the new commands/events.
- `DesktopUpdatePrompt` gains a second source: a staged hot bundle. The same drain gate
  (offline queue + outbox) applies before offering "Restart to update", which calls
  `restart_app`. If the user never restarts, the bundle applies on the next launch.
- `bundle_booted` is invoked once after the app mounts inside Tauri.
- `bundle://shell-outdated` triggers an immediate shell update check.

## Branding

The shell ships as **Aquilla**: `productName`, window title, `identifier`
`com.frontierrnd.aquilla`, `Info.plist` strings, release name. The deep-link scheme
gains `aquilla` and keeps `codex` for existing dev installs. Updater endpoint points at
`genesis-ai-dev/aquilla` releases.

## What needs Ryder (credentials)

See the PR body: Tauri updater keypair, bundle signing keypair, Apple Developer ID
certificate + notarization password, optional Windows certificate, the
`desktop-release-signing` GitHub environment, and an R2 bucket with a public domain for
the bundles.

## Non-goals

- Loading `aquilla.app` directly in the webview. It would move the origin (losing
  OPFS data), depend on WebKit's evictable caches for offline cold start, and let the
  client change mid-session. Rejected.
- Desktop pointing at staging. Hosts are baked into the bundle at build time; the
  production line publishes production bundles only.
