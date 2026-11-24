# 0016 — Smart edits are project-wide, on by default, and cheap per reader

*Decided and recorded 2026-11-21.*

## Context

Smart edits show a translator the wordings their team has already corrected
elsewhere in the project, with the correction offered. The suggestions were
always computed in auth-worker from the project's commit log
(`auth-worker/src/routes/ai-smart-edits.ts`). Only the switch was local: a
device flag, off by default, stored in one browser's IndexedDB. A team's
corrections therefore reached whoever found the switch, one browser at a time.

Turning a feature on for every member of every project multiplies whatever one
editor costs. Three costs were per reader and should not have been:

- every suggestion request ran a mining pass and rewrote the project's
  `smart_edit_state` row, so a team in one project queued on that row and read
  the same commits once each;
- every step to the next cell sent the whole passage again, to be scored again
  and, where the memory was unsure, verified by Jev again;
- every answer re-rendered every mounted row, because rows subscribed to one
  store-wide version number.

Mining that continued after the response also ran on the request's Postgres
handle, which is closed as the response returns.

## Decision

**The switch is a project setting, and absent means on.**
`ProjectWideSettings.smartEditsEnabled` lives in the shared settings blob at the
ordinary settings floor (maintainer). Every reader goes through
`src/lib/features/flags.ts::isSmartEditsEnabled`; only a stored `false` turns
smart edits off. The opt-in AI wording tier and the harmonizer stay device
flags in the same file.

**A project is mined at most once a minute, after the response.**
`auth-worker/src/lib/smart-edits/miner.ts::mineIfDue` treats
`smart_edit_state.updated_at` as a claim. One request per interval wins it with
a conditional `UPDATE` and its mining runs on its own connection
(`auth-worker/src/lib/post-response-db.ts::withPostResponseDb`); every other
request pays one primary-key read. Only a project's first pass is awaited.

**The editor asks about the cells it has no answer for.**
`src/lib/smart-edits/store.ts::SmartEditStore` records the text each answer was
for and which cells are already being asked about. The request still carries
the passage as context, and names the stale cells in `only`. An answer is not
discarded when the translator moves on: it is stored against the text it was
asked about, so a late one is still correct.

**A row re-renders for its own suggestions only.** The store hands each row the
same array until that row's suggestions change (the "subscribe to what you
render" rule of [0013](0013-interaction-cost-is-commits-times-tree.md)).

## Consequences

- An edit reaches the memory up to a minute later than before. It already
  waits ten minutes to settle (`src/lib/smart-edits/chains.ts::SETTLE_WINDOW_MS`).
- The server does not read the setting. Turning smart edits off stops every
  current client asking; it does not refuse a request made directly. The
  settings blob is too large to parse on each request, the per-user window
  bounds what a direct caller can spend, and `SMART_EDITS=off` is the
  operator's switch.
- A client that sends `only` to an older worker gets suggestions for every
  cell and keeps the ones it asked for; an older client gets the passage
  scored whole. Either side can deploy first.
- With the harmonizer flag on, the whole passage is asked about on each
  request, because its checks read across cells.

## Not covered yet

- The display thresholds (`src/lib/smart-edits/suggest.ts::DEFAULT_THRESHOLDS`)
  have not been tuned against real project history; the replay eval in
  `scripts/smart-edits-eval.ts` exists for that and has not been run on
  production data.
- Migration `db/postgres/migrations/0130_smart_edits.sql` must be applied to a
  database before its projects get suggestions. Where it is missing, requests
  answer with none.
- A project nobody opens is never mined. Its first reader waits for one
  bounded pass, and a long history is folded in over the following claims.
