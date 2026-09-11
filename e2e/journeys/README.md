# Agent journeys

Plain-English user journeys that an AI agent walks through the running app
with [agent-browser](https://github.com/vercel-labs/agent-browser). The agent
reads a story, drives the browser, judges the end state, and reports.

They exist for one job: QA on every pull request, done by bots against the
PR's own full-stack preview, with a comment a reviewer can act on. That
flow is written out in `PR-BOT.md`. The stories are the bots' briefs. The
replays are the parts of a story a bot no longer has to think about. The
comment reports the *effect* on the named screen, not that a control
moved: the first Grokbot walk of PR 626 flipped **Try Autopilot** and
called it good; the Autopilot panel on Overview stayed hidden until a
reload. A comment that says the walk passed without that check is a
failed bot run, not a review.

Calibration record, 2026-09-11: the 22 Grokbot comments from 2026-09-10
were re-walked on the same previews with a fresh account. Every walked
table row that could be re-checked held (556, 611, 612, 619, 620, 621,
627, 628, 509, 513). The errors were in the prose: a wrong behind-count
(26 for 41), a mislabelled timezone, a punctuation change in a quoted
button label, a two-level menu path collapsed to one, a workaround that
did not reproduce, request shapes taken from the diff instead of the
network, a HOLD over an HTTP 500, a BLOCKED on a preview that had
already deployed, and a walk posted after the PR had merged. Those rules
now live in `PR-BOT.md` under "Say only what you measured". The same
day Kieran cut the comment down: a pass is a two-line nod, a fail is the
item, the quoted string, and one thing to check, and every item is
walked three times so that 2/3 reads as a harness suspect, not a bug.

## Where this sits in the pipeline

| Stage | What runs | Where |
| --- | --- | --- |
| Push | secret scan, affected e2e, unit and worker suites (pre-push hook) | the developer's machine |
| Pull request | Cloudflare builds a full-stack preview of the branch (no tests) | Cloudflare |
| Pull request | bots walk the PR's claim and the touched stories against that preview, comment | wherever the bots run |
| Merge to dev | human sanity check of dev before main | a person |

No test runs inside Cloudflare any more; a green check means it compiled and
uploaded. The bots are what stands between a preview and a reviewer's
time. The Playwright smoke suite keeps its place on push and stays the
deterministic record of the same journeys.

## Stories, cold runs, replays

A **story** is the brief: preconditions, steps a person would take with
controls named by their visible label, the expected end state, and what
counts as a failure so the bot does not invent its own bar. One file per
journey, sections in that order, plus **Smoke twin** (the Playwright spec
for the same journey) and **Notes for the agent** (harness quirks learned
on earlier runs).

A **cold run** is a bot reading the story and finding the path from
scratch. That is the run that copes with a moved button, notices what a
selector cannot, and writes a report in words.

A **replay** (`replays/<slug>.sh`) is the path written down once found, as
agent-browser commands that exit 0 on PASS with the evidence on the last
line. It costs no tokens and runs in seconds, so it is what a bot runs
first on every PR for every story the diff touches. When a replay fails,
the bot cold-walks that story before reporting, so a harness miss is never
reported as a bug. A replay is deliberately not a Playwright spec: no
fixtures, no network interception, no reset.

## Calibration

A story earns trust only after its replay has passed five times in a row
on a build known to be good (the rule from the 2026-09-03 call). Until
then a red means the story or the harness is wrong, not the app.

```bash
sh e2e/journeys/streak.sh projects-create 5      # local stack
AQUILLA_BASE=https://<preview> AQUILLA_QA_USER=qa AQUILLA_QA_PASSWORD=... \
  sh e2e/journeys/streak.sh projects-create 5    # a PR preview
```

`streak.sh` appends one line per run to `streaks.tsv`; that file is the
calibration record. `FINDINGS-*.md` hold the tables per pass.

## Target and login

`AQUILLA_BASE` picks the app under test; unset means the local stack. A
preview's URL is `https://<branch alias>-aquilla-web-preview.<account>.workers.dev`
(the build log prints it as `app=`; the alias is the branch name lowered,
non-alphanumerics to `-`, cut at 30). `AQUILLA_ORG_ID` is the org the
stories work in (`9`, Dev Org, on the local seed).

On the local stack `login` opens `/__dev/login?as=<user>`. On a preview
that route does not exist; set `AQUILLA_QA_USER` and `AQUILLA_QA_PASSWORD`
and `login` signs in through the real form. Use a QA account on
development storage, never a production account.

## Fixtures on development storage

Every branch preview and dev.aquilla.app read and write one development
database, so the fixtures below are visible everywhere and shared with
everyone. Name them in stories; never paste an id.

- **Org:** QA Bot Workspace. **Accounts:** `qa-bot` (owner) and
  `qa-bot-2` (a plain member, for two-user and presence stories).
  Passwords live with the bot runner, not in this repo.
- **Projects:** `english to burmese` (Bible in Basic English from eBible)
  for Scripture stories; `QA Scripture Verse Resources` (Berean Standard
  Bible) for Verse Resources and Parallel Bibles; `QA Smoke Project` and
  `QA Org Search B`, both empty, for org, search, and import stories;
  `subtitle-test` for media.
- **Media:** in `subtitle-test`, files `001` to `012` are the repo's
  synthetic parity corpus (`parity/corpus/files/vtt/`). They have no
  film, no audio cues, and no takes; silence there is not a bug.
  `voices-roundtrip.vtt` has four cues and the cast Mary and John.
  `voices-roundtrip-film.mp4` is a 10-second test-pattern video imported
  as its own `video` file with five cells and its own sound. Any story
  that must hear something uses that file.
- **Where sound comes from:** a linked film plays muted beside the
  text; "Audio cues" is a transcript, not audio; what plays is the
  timeline, either takes on Target audio or the source audio of a
  media-imported file. The timeline's Sources menu says which of the
  three a file has.
- The seeded ids in the stories (`bestalu-bible`, org `9`) exist on the
  local stack only.
- Leave the workspace as you found it. Create throwaways under your own
  prefix and archive them when the walk ends. Never rename, archive, or
  delete the standing projects or the accounts.

## Running a story by hand

Install once: `npm i -g agent-browser && agent-browser install`. Boot the
local stack (`pnpm dev`, needs the `aquilla-dev-pg` container) or take a
preview URL. Then hand an agent the story and this prompt:

> Walk `e2e/journeys/<story>.md` against <base URL> with agent-browser.
> Use a named session. Re-snapshot after every page change. Report PASS or
> FAIL against "Expected end state", quote the evidence, and attach a
> screenshot of the end state. Do not fix the app.

## Running many

One story at a time per local stack. Two runs at once are fine; three
agents at once took the sync worker down. `wrangler dev` also exits when a
browser closes mid-socket (`Network connection lost.`), and the dev-stack
script then stops everything, so anything unattended on a local stack
needs a supervisor that restarts it and retries. A `FAIL: login` under
five seconds means the stack was down. Previews do not have this problem;
that is one more reason the bots should run against previews.

## Harness notes

- Prefer snapshot refs (`@eN`). `find role <role> --name` misses sidebar
  links, dialog checkboxes, and some icon buttons that the snapshot lists
  plainly. To act on one, pull its ref out of the snapshot
  (`ab snapshot -i -c | grep -o 'checkbox "I understand[^]]*ref=e[0-9]*'`)
  then `check @eN`; `replays/projects-archive.sh` shows the pattern.
- Some icon buttons never fire on a pointer click at all (the rule
  editor's **Edit rule** and **Cancel**). A DOM click through `eval`
  does; `replays/rules-custom-crud.sh` shows it.
- `wait --url` with a glob timed out on URLs it should have matched. Use
  `wait --text` or `wait --load networkidle`, then read `get url`.
- `wait --text` is page-wide and reads visible text only. A title in the
  breadcrumb or the "Back to" history button satisfies it while the table
  row is absent; a placeholder such as `Search projects…` never does.
  Scope checks with `snapshot -s <selector>` or `get count`, and wait for
  elements (`wait "table"`) rather than placeholder text.
- After clicking a cell's read view, wait for the editable element to
  mount and type into it by ref. Typing at "current focus" is lost.
- Language pickers on the create dialog accept a typed code (`en`, `fr`).
- Give the upload command an absolute path; the daemon resolves relative
  paths from its own working directory.
- Popovers and dialogs portal outside the row. Scope snapshots to `main` or
  `body` to see them; `-i` hides non-interactive text, so read a posted
  comment with `get text`.

- **Recording needs a fake microphone.** Headless Chromium reports the
  mic permission as denied, and the app hides the record button behind a
  help popover when it sees that. Launch with
  `agent-browser --args --use-fake-ui-for-media-stream,--use-fake-device-for-media-stream,--use-file-for-fake-audio-capture=<wav> --init-script <script>`
  where the script overrides `navigator.permissions.query` for
  `microphone` to return `granted`. The WAV plays as the microphone, so a
  take has sound in it. The flags apply only on a fresh launch; `close`
  the session first.
- **The Whisper prompt.** After the first media import or recording in a
  browser, the app asks once whether to download Whisper for local
  transcription. Choose Cancel; a story that needs transcripts imports a
  VTT instead.
- **The player is not in the DOM.** Playback goes through a detached
  `new Audio(url)`, so `document.querySelector("video,audio")` finds
  nothing while sound plays. To see the source, wrap
  `HTMLMediaElement.prototype.play`; to prove the audio is audible, fetch
  the URL in the page, `decodeAudioData` it, and report RMS and peak.

## Relationship to the repo's skills

- `.agents/skills/verify-dev-change`: a developer's agent drives the local
  stack as the seeded dev user to prove its own change before saying
  "done". Same idea one step earlier: one person, one change, one machine,
  no written journey. This folder is the other side of the PR: someone
  else's change, on its preview, against journeys the team agreed on.
- `.agents/skills/agent-browser`: the stock discovery stub for the CLI the
  replays use. Nothing here replaces it; `agent-browser skills get core` is
  still the usage guide.
- `.agents/skills/to-issues` and `triage`: where a bot's finding goes when
  it is real. A PR comment is the first stop; a ticket follows only after
  a person agrees.
