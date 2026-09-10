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
  branch's auth and sync workers on development storage.
- A QA account on development storage. Never a production account.

## Hard stops

Do not walk the app. Leave one comment with status **BLOCKED** and stop.

- The PR has merge conflicts with `dev`. The team's review standard gives
  conflicts back to the author unfixed. Do not "QA around" them.
- There is no preview URL, or the preview does not load. Exception:
  docs-only diffs (`e2e/journeys/*.md`, README, comments) have no UI
  claim; skip the walk, do not BLOCKED-loop on a failed SPA preview.
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

## Status

- **FAIL** if any walked checklist item missed its named effect. A 500
  on the grant path is FAIL even when the instructions page looks
  right (PR 628). HOLD is illegal when the table contains a FAIL.
- **HOLD** only when every walked item showed the effect, and every
  unwalked item is listed under **Did not walk** with why. A 2-org
  account does not satisfy a >100-org AC; that row is NOT CHECKED,
  not a pass (PR 509).
- **BLOCKED** only for a hard stop above.

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
   (`AQUILLA_BASE=<preview> sh e2e/journeys/streak.sh <slug> 1` per story),
   then cold-walk any story whose replay failed, so a harness miss is not
   reported as a bug. If the runtime has no agent-browser, cold-walk the
   matching stories in the computer instead, and say that in the comment.

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

## False greens to refuse

Do not write HOLD or anything that reads as "good" when the only evidence
is any of:

- The control moved.
- The page did not error.
- The author ticked **Dev check**.
- Unit tests in the PR body are green.
- "Technically not broken."

Those are notes, not a walk.

## Comment template

Status is exactly one of: **HOLD**, **FAIL**, **BLOCKED** (see **Status**
above). Never "LGTM", "looks good", "PASS", "walked", or "approved."
HOLD means "here is what I saw"; a person still looks. If the table has
a FAIL row, the header is FAIL.

```
## Bot walk — PR <n>

**Status:** HOLD | FAIL | BLOCKED

**Claim** (quoted from the QA checklist / AC, not paraphrased)

**Preview:** <url>
**Signed in as:** <role, not just the email>
**Stories:** <slugs, or "none">

### Walked
| Checklist item (verbatim) | Result | When it showed | Evidence |
| --- | --- | --- | --- |
| … | yes / no / NOT CHECKED | immediate / after navigation / after reload / never | screenshot or quote |

### Did not walk
- <item>: <why, one line>

### What a human should look at first
One sentence. On a FAIL, name the screen and the missing effect. On a
HOLD, name the riskiest check you did not do (a second role, a second
browser, a reload you skipped).
```

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
