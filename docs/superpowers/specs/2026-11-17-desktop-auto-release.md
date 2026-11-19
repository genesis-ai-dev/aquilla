# Desktop shell releases that cut, verify and promote themselves

*2026-11-17. No Linear issue yet. The operating guide is `docs/DESKTOP-RELEASES.md`;
this page is why it is shaped that way and what is left.*

## Problem

A shell release took three manual steps: bump four files, push a `v*` tag,
approve the signing gate. Two things went wrong with that in one week.

- The Paratext 10 registration lookup merged on 2026-11-13. No installed app
  had it until 2026-11-17, because nobody cut a release. Hot bundles deliver
  the web app hourly; they never carry Rust.
- When v0.2.4 was cut, the first finished build published the release. Apple's
  notary service failed the Intel macOS build with an HTTP 500, and for hours
  the update feed offered Windows and Linux a release macOS did not have.

## What the approval click was covering

| Risk | Was covered by | Now covered by |
| --- | --- | --- |
| A release nobody cut | a person remembering | `desktop-release-cut.yml`, nightly |
| A partial release (a platform missing from the feed) | nothing | draft until all four builds finish; `manifestProblems` |
| An update the app refuses (bad updater signature) | nothing | `verifyUpdaterSignature` on every file |
| A build macOS will not open | nothing | `codesign` and Gatekeeper checks |
| A shell that crashes on start | the smoke suite, on a debug build | the signed build is started and must stay up |
| A transient notarization failure | a person re-running the job | one automatic second attempt |
| A broken self-update from the previous version | nothing | **nothing yet** (phase 2) |
| Data lost across an upgrade | nothing | **nothing yet** (phase 2) |
| A commit that should not be signed at all | the approval click | **still the approval click** |

The last row is the one tests cannot replace. It is a question about who may
ship, not whether the build works. `docs/DESKTOP-RELEASES.md` lists the three
repository settings that answer it without a click. They are the owner's to
change; nothing here changes them.

## Decisions

- **Draft, verify, promote** rather than automating the approval. Verification
  runs on the signed files users would receive, which an approval before the
  build never could. The gate stays where it is and becomes optional later.
- **The version on `dev` is the release request.** An untagged version gets
  tagged, whoever bumped it. The nightly job only adds the bump when the shell
  changed. One rule covers the manual and the automatic path.
- **Nightly, not per merge.** A release is about an hour of four-platform
  builds and moves `minShellVersion`. "Run workflow" is there for an urgent fix.
- **The bump goes through a pull request.** `dev` has a required check, and a
  pull request is how everything else gets there. The workflow merges it only
  when the diff is exactly the four version files.
- **Off by default.** `DESKTOP_AUTO_RELEASE` must be `true` for scheduled and
  push runs.
- **No self-hosted runners.** The repository is public.

## Phase 2, not built

1. **Live self-update test.** Install the previous release, point it at the
   candidate's feed, let its own updater install the candidate, confirm the new
   version starts. Needs the shell to accept a feed override; the updater still
   checks the signature against the compiled-in key, so an override cannot
   install unsigned code, but it is a shell change and wants its own review.
   It only starts working one release after it ships.
2. **Data survives the upgrade.** In the same test: sign in, leave an offline
   edit, upgrade, confirm both are still there.
3. **Home-machine check.** A scheduled task on a Mac and a Windows machine that
   runs `pnpm desktop:release:verify <tag> --launch` on each new release, then
   the Paratext scan against real Paratext 9, 10 and Lite installs, and posts
   to #aquilla-alerts. Pull, not push, because of the public repository.
4. **Windows Authenticode.** No `WINDOWS_CERTIFICATE` secret exists, so Windows
   builds show a SmartScreen warning. The verifier reports it and does not fail.
5. **The native smoke suite on the signed build.** It needs the WebDriver
   feature, which is deliberately absent from signed builds.

## Verified on 2026-11-17

- The verifier, run on a Mac against the published v0.2.3: all four platforms
  present, 12 feed entries signed by the updater key, both macOS builds signed
  and notarized, the arm64 app still running after 30 seconds.
- The verifier against v0.2.4 as first published: failed, naming the two
  missing macOS entries.
- `planCut` and the version rewrite: unit tests, including the repository's
  real version files.

Not verified before merge: the Windows and Linux halves of the verifier (the
pull request's own run is their first), and the cut workflow end to end, which
cannot run until it is on `dev`.
