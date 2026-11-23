# 0012 — A desktop release is a draft until it is verified

*Decided and recorded 2026-11-17, after v0.2.4. No Linear issue yet.*

## Context

An installed app updates its shell from the latest published GitHub release.
The first platform build to finish used to publish that release, so the update
feed listed only the platforms built so far. On 2026-11-17 Apple's notary
service failed the Intel macOS build of v0.2.4; Windows and Linux were offered
the release for hours while macOS was not, and nothing reported it.

A shell release also could not happen without a person: four version files, a
tag, an approval. A Rust fix merged on 2026-11-13 reached no user for four
days. Hot bundles never carry Rust.

## Decision

1. The build uploads to a draft. Only the `promote` job publishes it, and only
   after every build and every verify job has passed.
2. Verification runs on the files users would receive.
   `scripts/lib/desktop-release.ts::manifestProblems` requires every platform
   in `scripts/lib/desktop-release.ts::REQUIRED_PLATFORMS`, and
   `scripts/lib/desktop-release.ts::verifyUpdaterSignature` makes the check the
   app's own updater makes. `scripts/desktop-release-verify.ts` then starts the
   signed build on each operating system.
3. The version on `dev` is the request to release.
   `scripts/lib/desktop-release.ts::planCut` tags a version that has no tag,
   and opens the bump only when a file under the shell's folder changed since
   the last tag.
4. The signing approval is not replaced by any of this. It decides whether a
   commit may be signed, which is not a property a test of the build can show.

## Consequences

- A failed or partial release changes nothing for any user. It costs a re-run,
  not a broken update.
- A release takes longer to appear: the verify jobs run after the slowest
  build.
- Adding a platform means adding it to the required list, or the release
  passes without it.
- The bump pull request is merged by a workflow. That is the one exception to
  "Actions does not click merge", and it holds only while the diff is the four
  files in `scripts/lib/desktop-release.ts::VERSION_FILES`.
- The whole line is in `docs/DESKTOP-RELEASES.md`.

## Not covered yet

- An installed older app updating itself to the candidate, and its data
  surviving. Both need a shell change.
- Windows Authenticode signing. The verifier reports its absence.
- Removing the approval. The repository settings that would make that safe are
  listed in the guide and are not set.
