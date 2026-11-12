---
name: attention-queue
description: Build a short, ranked list of what needs attention in one Aquilla translation project this week — weak files, open reviewer threads, term drift and stalled approvals. Use when the user asks what to work on next or what is at risk.
---

# Attention queue

Use this when the user asks "what should we work on?", "what is at risk?" or
"what needs attention this week?" for one project. The output is a ranked list
of at most ten items, each with a reason and a suggested owner.

## Steps

1. If the project is not clear, call `list_projects` and ask the user to pick.
2. Call `read_quality` for the project. Collect started files (health not
   null) and their health, filled % and validated %.
3. Call `read_comments` (limit 200, page with `cursor` if needed). Group open
   thread roots (`parentCommentId` null, `resolved` false, no `deletedAt`) by
   file.
4. Call `read_term_consistency` with `onlyDrift: true`. Note concepts with
   flagged cells and the files they sit in.
5. Call `list_changesets` with `status: "staged"`. Anything staged for more
   than a few days is stalled.
6. Rank and write the queue.

## Ranking

Put the most blocking work first:

1. Open reviewer threads — a person is waiting for an answer.
2. Stalled staged changesets — work is done but not saved.
3. Term drift in key terms — it spreads if left alone.
4. Started files with the lowest health.
5. Files that are mostly drafted but barely validated — ready for review.

Merge items about the same file into one line. Stop at ten.

## Output

For each item: file name, what is wrong in one short sentence, and the role
that should act (translator, reviewer, consultant, project manager). End with
one sentence on what the user could ask you to do next, for example "I can
draft fixes for the term drift for you to approve."

## Do not

- Do not stage changes from this skill. Offer to, and wait for the user.
- Do not compute health or coverage yourself. Use the numbers Aquilla returns.
