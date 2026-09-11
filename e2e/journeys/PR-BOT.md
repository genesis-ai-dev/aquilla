# The PR bot

What a bot does with a pull request, written so any agent (Claude Code with
agent-browser, Grokbot, Codex with Astra) can follow it. The stories in this
folder are its briefs; the replays are the checks it can run without
thinking.

A human still decides. The comment is evidence, not a verdict. Never approve
the PR, never request changes as a GitHub review, never merge, never push.

## Input

- The pull request number, its title and body, and its diff summary.
- The Linear ticket linked from the body, if any: acceptance criteria first.
- The branch's full-stack preview URL. Cloudflare builds one per branch
  (`docs/runbooks/cloudflare-workers-builds.md`, "Pull-request previews");
  the build log prints it as `app=`. It serves the web app with that
  branch's auth and sync workers on development storage. The alias is
  per branch, never per commit: `ci-<branch slug>-<hash>` serves the
  branch's latest successful build. Read `<preview>/version.json` and
  compare its `sha` to the PR HEAD. That file is the readiness check;
  the Cloudflare comment on the PR lags it by minutes. A URL such as
  `ci-dev-<commit>` does not exist, so a 404 there proves nothing.
- A QA account on development storage. Never a production account.

## Hard stops

Do not walk the app. Leave one comment with status **BLOCKED** and stop.

- The PR has merge conflicts with `dev`. The team's review standard gives
  conflicts back to the author unfixed. Do not "QA around" them.
- There is no preview URL, or the preview does not load, or
  `version.json` shows an older sha than HEAD after the build for HEAD
  has finished. Decide from `version.json`, not from the Cloudflare
  comment. Exception: docs-only diffs (`e2e/journeys/*.md`, README,
  comments) have no UI claim; skip the walk, do not BLOCKED-loop on a
  failed SPA preview.
- Sign-in on the preview fails.

**Not a hard stop:** the branch is behind `dev` but mergeable, with a
preview of *this* HEAD. Walk it. Note how far behind in the comment.
Skipping every stale PR means the bot walks almost nothing in a large
queue, and the preview is still that branch's code.

**Do not pick up** unless a human names the number:

- Deploy PRs (`Deploy YYYY-MM-DD`, base `main`). Those are grouping
  records, not a feature claim.
- Dependabot / chore PRs with no user-visible surface.

**One comment per HEAD.** If you already commented on this SHA, stop.
If HEAD moved, one new comment for the new SHA. Do not stack BLOCKED
notes on the same docs PR.

**Re-read the PR right before posting.** A walk takes long enough for
the PR to merge or move. If it is merged or closed, or HEAD is no
longer the sha you walked, do not post; PR 513 got its walk 34 minutes
after Matthew merged it.

## Status

A walk is a walk. A person walks a claim once and tries again only
when something smells off; the bot does the same. Repetition belongs
in two narrower places: a miss, and the replays.

- **Walk each checklist item once.** If it shows its effect, that item
  is done: 1/1.
- **On a miss, walk that item twice more** in fresh sessions before
  deciding. The bot does not yet know whether it found a bug or tripped
  over its own harness, and that is the moment to look again.
- **Run the replays three times** (`streak.sh <slug> 3`). They are
  scripts; their job is to be deterministic, and a replay that passes
  2/3 is telling you the script is loose. Only n/n counts as a passing
  replay.

- **PASS** when every walked item showed its effect on its first walk,
  every replay passed n/n, and every unwalked item is named with why.
  A 2-org account does not satisfy a >100-org AC; that item is not
  walked, not passed (PR 509). PASS is a nod, not an approval: a
  person still looks.
- **FAIL** when an item missed its effect on all three walks. A 500 on
  the grant path is FAIL even when the instructions page looks right
  (PR 628). PASS is illegal when any item failed.
- **FLAKY** when an item missed once and then showed on a retry (1/3,
  2/3), or a replay passed on some runs and not others. That is a
  harness suspect first and an app bug second. Say which item and
  which run missed; do not call it a bug until a cold walk misses too.
- **BLOCKED** only for a hard stop above.
- A step the PR body itself leaves unticked ("secret not configured
  yet") is not walked, with that reason; it is not FAIL. FAIL is for
  an effect the PR claims and the preview does not show (PR 630).
- One server fault is one item. If two checklist items die on the same
  HTTP 500, say so once (PR 628: the consent page's error was the same
  500 as the grant).

## Steps

1. **Read the PR like a reviewer.** The test is not a sentence you invent.
   Copy, in order, every user-visible item from:
   - the Linear acceptance criteria
   - the PR body's **QA checklist** (the "verify locally" / "as any role"
     steps)
   - any manual UI line in **Test Checklist**
   Then write one sentence for the *effect*: what a user should see on
   which screen after the change. The control they click is not the
   effect. On AQU-1246 / PR 626 the control was **Try Autopilot**; the
   effect was "the Autopilot panel is absent on Overview until an
   owner/lead opts in, then present for every member without a refresh."
   A bot that only flipped the switch and said it worked missed the bug
   Matthew caught on the first run: the panel stayed hidden on the
   project page until a reload.

2. **Pick the stories the diff touches.** Grep `JOURNEYS.md` and this
   folder by the components, hooks, and routes in the diff. Those stories
   are the regression set. A PR that touches nothing a story covers still
   gets step 3.

3. **Walk the claim on the preview.** Drive the real UI (Grokbot computer
   use, Astra, or agent-browser). For each checklist item, do the clicks a
   person would do, then judge the *effect* on the screen the PR named.
   Screenshot each item. Follow **Effect, not control** below. Judge
   against the copied checklist, not against "the page still loads."

4. **Run the regression replays** against the same preview
   (`AQUILLA_BASE=<preview> sh e2e/journeys/streak.sh <slug> 3` per story),
   then cold-walk any story whose replay failed, so a harness miss is not
   reported as a bug. If the runtime has no agent-browser, cold-walk the
   matching stories in the computer instead, and say that in the comment.
   The claim walk in step 3 is not repeated unless an item missed;
   then that item alone gets two more fresh sessions (see **Status**).

5. **Comment on the PR.** One issue comment, never a GitHub review
   approval. Use the template below. Do not fix the app. Do not push.

## Effect, not control

A flipped switch, a toast, or a missing error is not a pass.

After any setting, flag, or toggle:

1. Stay on the page. Did anything else change, or only the control?
2. Navigate, **without a full reload**, to every surface the PR says
   should change (Overview, editor, another member's session, …).
3. Reload those surfaces.
4. Report the three moments separately: immediate, after navigation, after
   reload.

If the PR names roles, check the named roles or write **NOT CHECKED**
with the role you lacked. "I was already an owner" does not cover
"contributor cannot save."

If the PR says a surface is *absent* (not disabled), assert absence: the
heading, button, or test-id is not in the snapshot. A greyed-out control
is a fail against an absence claim.

Persistence claims get a reload. Appearance claims get navigation without
reload *and* a reload. The 626 miss was an appearance claim treated as a
click claim.

## Say only what you measured

The 2026-09-11 re-walk of 22 bot comments found every walked table row
true and every error in the prose around the tables. These rules come
from those errors.

- **Numbers come from an API or a snapshot, never from memory.**
  "Commits behind" is `behind_by` from
  `GET /repos/genesis-ai-dev/aquilla/compare/<dev sha>...<head sha>`;
  the bot wrote "26 commits behind" on two PRs where GitHub said 41,
  and the author repeated the wrong number. Row counts come from the
  snapshot you took.
- **Times are UTC and say so.** The Cloudflare API reports UTC; "17:48
  PT" on PR 630 was UTC mislabelled.
- **UI strings are copied from the snapshot, byte for byte.** No added
  punctuation: the button read `Copied`, the comment said "Copied.".
  Call an element by what the snapshot says it is (a paragraph is not
  a heading). A reference label is quoted as rendered; if the panel
  shows `GEN 2 1`, do not write `GEN 2:1`.
- **Menu paths list every level.** "⋯ → Split into milestones" was
  wrong; the switch lives at ⋯ (File options) → Editor settings →
  Split into milestones. Take the path from the snapshots you walked.
- **Default-state claims need a fresh fixture.** "OFF by default" is
  only evidence on a project nobody has touched. Create one; do not
  reuse a shared QA project. If a setting is on by default, say "on by
  default", not "after enabling".
- **Observation and hypothesis go in different sentences.** "HTTP 500
  on device_authorization" is observed. "Consistent with migration
  0090 not applied" is a guess; label it as one.
- **Request shapes come from captured requests, not from the diff.**
  PR 509's comment told the reviewer to confirm `GET /orgs?q&limit=40`
  and `POST /orgs/portfolio {q, limit}`; the page sends neither shape.
- **A workaround is reported only if it reproduced twice.** The
  "Cloudflare 1010 blocks non-browser user agents" note on PR 627 did
  not reproduce; it went into the record anyway.
- **Seed ids in stories exist on the local stack only.** The
  `bestalu-bible` project id in `projects-route-health.md` is not on
  development storage; do not try it on a preview.
- **Evidence is a quote or a measurement, not a filename.** A
  screenshot nobody can open is not evidence. On a FAIL, quote the
  string or the value you saw; on a PASS, nothing.
- **Say what you did to reach a surface.** The recording modal needs
  the cell expanded and a microphone permission; a walk that skips that
  cannot be repeated by a person.
- **Tokens minted on one preview work on every preview** (shared
  credential store). Mint once, say which preview minted it.

## False greens to refuse

Do not write PASS or anything that reads as "good" when the only evidence
is any of:

- The control moved.
- The page did not error.
- The author ticked **Dev check**.
- Unit tests in the PR body are green.
- "Technically not broken."

Those are notes, not a walk.

## Comment template

Short. A reviewer reads the first line and knows whether to look. Status
is exactly one of **PASS**, **FAIL**, **FLAKY**, **BLOCKED**. Never
"approved" or "LGTM": the bot may say the change looks good; it may not
say it is accepted.

The counts are items, not repetitions: "walk 4/4" means four checklist
items, each seen once; "replays 9/9" means three stories at three runs
each. On a PASS, the whole comment is the nod:

```
## Bot walk — PR <n> @ <sha>

**PASS** · walk 4/4 · replays 9/9 · <preview url> · as <role>

Walked: <checklist items, one line, in the PR's words>.
Not walked: <items and why, one line; or "none">.
```

On a FAIL or FLAKY, add only what a person needs to reproduce and
decide:

```
## Bot walk — PR <n> @ <sha>

**FAIL** · walk 3/4, one item 0/3 · <preview url> · as <role>

<Checklist item, verbatim>: expected <effect> on <screen>; saw
`<quoted string or measured value>` on all three walks.

Check: <one sentence, the screen and the step>.
```

```
**FLAKY** · one item 2/3 · …

<Checklist item>: missed on the first walk at <step>, showed on both
retries. Harness suspect; a person should cold-walk it once before
anyone calls it a bug.
```

```
**FLAKY** · replays 8/9 · …

<story slug>: run 2 failed at <step>; the claim walk passed 4/4.
Replay suspect; see streaks.tsv before treating it as a bug.
```

On a BLOCKED, one line: the hard stop and what unblocks it.

What stays out: a "Tried" narrative, a "Worked" table on a pass,
screenshot filenames, timings, notes on how the runner was configured,
and anything the bot saw that it did not measure. The 22 comments of
2026-09-10 averaged 2,700 characters; the tables were right and nobody
read past them.

**Outside this PR.** If the walk trips over a bug the PR did not touch,
reproduce it twice, then add one line under the heading **Outside this
PR:** with the screen and the quoted string. One line, no ticket
unless a person asks. Do not mention anything seen once.

## What the comment is for

The reviewer should skip "did the switch flip" and spend their time on
"is this the right change." When something ships that a bot should have
caught, the fix is a sharper claim in this file or a new story, not a
longer human checklist. Ryder's bar from the 2026-09-10 call: we start
relying on the bots only once Matthew looks and they keep being right.
Until then the comment is a first pass.

## Fleet, once the preview is routine

- One bot per story on every PR, in parallel, each with its own session.
- One bot with no story: explore the PR's surface and report what looks
  wrong (agent-browser's `dogfood` skill is the shape of that job).
- One orchestrated group of ten users editing one file on a throttled
  connection, for PRs that touch sync. Ten bots that can talk to each
  other can stage the race the throttled smoke spec assumes.
- All of it against the preview, never against a laptop. The local stack
  is for writing and calibrating stories.
