# Desktop shell releases

How a change to the desktop shell (`src-tauri/`) reaches an installed Aquilla
app, what stops a bad build on the way, and which parts are still a person's
job. The hot-bundle channel, which delivers the web app to the shell every
hour, is a different line: `docs/superpowers/specs/2026-11-05-desktop-hot-bundle.md`.

**A fix in Rust reaches nobody until a new shell is released.** Hot bundles
carry the web app only. The Paratext 10 registration lookup merged on
2026-11-13 and no user had it until v0.2.4, four days later, because cutting a
release was something a person had to remember. This line exists so that it is
not.

## The line

```text
shell change merges to dev
        │  nightly, or "Run workflow"
        ▼
desktop-release-cut.yml ── opens the version bump PR, merges it when green
        │  tags v<version> on dev
        ▼
tauri-release.yml
   build ×4   signing gate, then build, sign, notarize; uploads to a DRAFT release
   stage      copies the draft's files into a run artifact
   verify ×3  macOS, Windows, Linux: desktop-release-verify.yml
   promote    publishes the draft as the latest release
   report     one line in #aquilla-alerts, either way
        ▼
installed apps see it at their next check (on start, then every 6 hours)
```

| Step | Where the rule lives |
| --- | --- |
| Should a release be cut, and which version | `scripts/lib/desktop-release.ts::planCut` |
| The four version copies move together | `scripts/lib/desktop-release.ts::bumpVersionFile`, `scripts/app-version.test.ts` |
| A release is complete | `scripts/lib/desktop-release.ts::manifestProblems` |
| An update file is one the app will accept | `scripts/lib/desktop-release.ts::verifyUpdaterSignature` |
| The checks themselves | `scripts/desktop-release-verify.ts` |

### Cutting

`desktop-release-cut.yml` runs nightly, on a push to `dev` that changes
`src-tauri/tauri.conf.json`, and on "Run workflow". It asks
`scripts/desktop-release-cut.ts plan` and does one of three things:

- **tag** — `dev` carries a version with no `v*` tag. It tags `dev`'s head.
  This is also what releases a bump someone merged by hand.
- **bump** — a file under `src-tauri/` changed since the last tag and no bump
  is open. It opens a pull request that moves the version in the four files,
  waits for that pull request's checks, merges it, and tags.
- **none** — no shell change, or a bump is already open.

Nightly, so a day's shell merges are one release. A web-only change never cuts
a release.

The scheduled and push runs do nothing until the repository variable
`DESKTOP_AUTO_RELEASE` is `true`. "Run workflow" always works, and has a
plan-only box.

The bump pull request is the one pull request Actions merges by itself.
AGENTS.md says Actions does not click merge because auto-merge cannot read
`on hold` or a stacked parent; neither can apply to a pull request the
workflow opened a minute earlier, and the workflow refuses to merge unless the
diff is the four version files and nothing else.

**The version is also the hot bundle's `minShellVersion`.** From the moment
the bump merges, new web bundles are not offered to older shells. That window
closes when users install the new shell, so the tag follows the merge in the
same run.

### Building

`tauri-release.yml` is unchanged up to the upload: the
`desktop-release-signing` Environment, typecheck and unit tests, the Rust
tests, the native smoke suite, then `tauri-action` signs and notarizes.

Two things changed:

- **The release is a draft.** The first build to finish used to publish it,
  and the update feed (`latest.json`) then carried only the platforms that had
  finished. v0.2.4 offered Windows and Linux an update for hours while macOS
  had none, and would have left Intel Macs without one for good had nobody
  re-run the failed job.
- **The upload is tried twice.** Apple's notary service fails healthy uploads
  with an HTTP 500 (it failed the Intel build of v0.2.4). The second attempt
  runs only if the first failed.

### What verification proves

`scripts/desktop-release-verify.ts <tag> --launch`, on macOS, Windows and
Linux runners. It fails the release, naming each problem, when:

| Check | The failure it stops |
| --- | --- |
| `latest.json` is at the tag's version and has `darwin-aarch64`, `darwin-x86_64`, `windows-x86_64` and `linux-x86_64` | a platform that is never offered the release, silently |
| every update file's signature verifies against `plugins.updater.pubkey` | an update every app downloads and then refuses |
| macOS: `codesign --verify --deep --strict` on both architectures | a bundle damaged after signing |
| macOS: Gatekeeper assesses both as "Notarized Developer ID" | an app macOS refuses to open |
| the build for this OS is installed (Windows) or unpacked (macOS, Linux), started, and still running after 30 seconds | a shell that crashes on start; such a shell cannot update itself out of the problem |

It reports, without failing, the Windows installer's Authenticode status. The
Windows build is not Authenticode-signed today (there is no
`WINDOWS_CERTIFICATE` secret), so Windows shows a SmartScreen warning.

Run it yourself against any published release:

```bash
pnpm desktop:release:verify v0.2.4 --launch
```

It starts the app with a temporary `HOME`, so it does not touch your installed
Aquilla's data folder.

A pull request that changes the verifier runs it against the latest published
release on all three operating systems, so a verifier that would wrongly fail
the next release is caught on the pull request that broke it.

### Promoting

`promote` publishes the draft and marks it latest. That, not the build, is
what installed apps can see. If any build, or any verify job, fails, the
release stays a draft, nothing changes for any user, and `report` posts the run
link to #aquilla-alerts.

To finish a release whose build failed for an outside reason (Apple, a
runner): re-run the failed jobs of the `tauri-release` run. The later jobs
then run by themselves.

## What verification does not prove

- **That the previous version can update itself to this one.** The update
  files are proven to be the ones the app would accept, and the new shell is
  proven to start. Nothing yet drives an installed older app through its own
  updater. That needs the app to read a candidate feed, which is a shell
  change (see the spec).
- **That local data survives the upgrade.**
- **That any feature works.** The native smoke suite runs before the build, on
  a debug binary, not on the signed one.
- **That a change which works is a change you wanted.** That is review.

## The signing gate

`tauri-release.yml`'s build job enters the `desktop-release-signing`
Environment, which today requires @ryderwishart to approve each run. That
approval answers two different questions, and only one of them is about
quality.

1. **Is this build good?** Verification now answers that, after the build and
   before any user sees it.
2. **May this commit be signed as Aquilla?** Nothing in this pull request
   answers that. Any pushed `v*` tag, on any commit, reaches the Apple and
   updater signing keys once the gate lets it through.

So the approval can be removed, and releases become hands-free, **once
question 2 has another answer**. Three repository settings give it one. They
are settings, not files, and changing them is the owner's call:

| Setting | Why |
| --- | --- |
| A tag ruleset on `v*`: only the release bot may create, update or delete | Otherwise anyone with write access pushes a tag and gets a signed build of any commit. The existing "release tags" ruleset covers `20*` only. |
| The Environment's deployment rule: tags matching `v*` only | So no branch run can enter it. |
| Code-owner review required on `dev` for `src-tauri/` (and already for `.github/workflows/`) | `dev` requires no approving review today, and agents merge their own pull requests. Without this, removing the gate means an agent's merge to `src-tauri/` is signed and shipped with no person having read it. |

Until those are in place, keep the reviewer. The line is still automatic up to
that one click, and the run waits for it instead of being forgotten.

## Turning it on

1. Merge this. Nothing runs by itself yet.
2. "Run workflow" on `desktop-release-cut` with plan-only ticked. Read the plan
   in the run summary.
3. Set the repository variable `DESKTOP_AUTO_RELEASE` to `true`.
4. Optional, later: the three settings above, then remove the required
   reviewer from `desktop-release-signing`.

`RELEASE_BOT_TOKEN` must be able to push tags and branches and to open and
merge pull requests. The cut fails with a clear error when it is missing; it
cannot fall back to `GITHUB_TOKEN`, because GitHub starts no workflow for a
tag that token pushes.

## Machines at home

This repository is public. A self-hosted runner attached to a public
repository runs whatever a pull request's workflow tells it to, including a
pull request from a fork that edits the workflow. Do not register a home
machine as a runner here.

A home Mac or Windows machine can still check every release, by pulling
instead of being pushed to: a scheduled task that runs
`pnpm desktop:release:verify <tag> --launch` against the newest release and
posts the result. Those machines add what cloud runners lack, real Paratext 9,
10 and Lite installs. That task is not built yet (see the spec).
