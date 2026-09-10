# The PR bot

What a bot does with a pull request, written so any agent (Claude Code with
agent-browser, Grokbot, Codex with Astra) can follow it. The stories in this
folder are its briefs; the replays are the checks it can run without
thinking.

## Input

- The pull request number, its title and body, and its diff summary.
- The branch's full-stack preview URL. Cloudflare builds one per branch
  (`docs/runbooks/cloudflare-workers-builds.md`, "Pull-request previews");
  the build log prints it as `app=`. It serves the web app with that
  branch's auth and sync workers on development storage.
- A QA account on development storage. Never a production account.

## Steps

1. **Read the PR like a reviewer.** From the body and the Linear ticket,
   write down in one or two sentences what a user should be able to do
   after this change that they could not before, or what should stop
   happening. That sentence is the test.
2. **Pick the stories the diff touches.** Grep `JOURNEYS.md` and this
   folder by the components, hooks, and routes in the diff. Those stories
   are the regression set. A PR that touches nothing a story covers still
   gets step 3.
3. **Walk the PR's own claim** against the preview with agent-browser,
   snapshot by snapshot, the way the stories describe a journey. Judge the
   end state against the sentence from step 1. Screenshot it.
4. **Run the regression replays** against the same preview
   (`AQUILLA_BASE=<preview> sh e2e/journeys/streak.sh <slug> 1` per story),
   then cold-walk any story whose replay failed, so a harness miss is not
   reported as a bug.
5. **Comment on the PR.** One comment, three parts: what was tried (the
   sentence from step 1 plus the story list), what worked, what did not,
   each failure with the step, the evidence, and a screenshot. Say plainly
   when a failure looks like a harness or preview problem rather than the
   app. Do not fix the app, do not push to the branch.

## What the comment is for

A human still decides. The comment lets the reviewer skip the part an agent
can do (does the claim hold, did the neighbours survive) and spend their
time on the part it cannot (is this the right change). When something
ships that a bot should have caught, the fix is a new or sharper story, not
a longer human checklist.

## Fleet, once the preview is routine

- One bot per story on every PR, in parallel, each with its own session.
- One bot with no story: explore the PR's surface and report what looks
  wrong (agent-browser's `dogfood` skill is the shape of that job).
- One orchestrated group of ten users editing one file on a throttled
  connection, for PRs that touch sync. Ten bots that can talk to each other
  can stage the race the throttled smoke spec assumes.
- All of it against the preview, never against a laptop. The local stack is
  for writing and calibrating stories.
