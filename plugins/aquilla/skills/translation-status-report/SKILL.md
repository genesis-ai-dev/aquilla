---
name: translation-status-report
description: Write a plain-language status report on one or more Aquilla translation projects for a manager, funder or partner. Use when the user asks where a project stands, for a weekly or monthly update, or for a report to send to someone.
---

# Translation status report

Use this when someone asks "where are we?", wants a weekly update, or needs a
report for a funder, board or partner. The reader manages translation work.
They want progress, risk and next actions — not cell data.

## Steps

1. Call `get_capabilities` once. Note the mode (ask or act) and scope.
2. Call `list_projects`. If the user named a project, use only that one.
   Otherwise report on every project in scope, up to 10. If there are more,
   say so and ask which ones matter.
3. For each project, call `read_quality`. Take `coverage` (filled and validated
   percentages) and `projectHealth` exactly as returned. Never compute coverage
   or health yourself from `read_content`: your numbers will not match what the
   team sees in Aquilla.
   - A file with `health: null` has not started. It is not unhealthy.
   - Note the three started files with the lowest health.
4. For each project, call `read_comments` (limit 200). Count open threads:
   items with `parentCommentId` null, `resolved` false and no `deletedAt`.
   Note the oldest open thread's file.
5. Call `list_changesets` with `status: "staged"` for each project. These are
   changes this connection prepared that still wait for a person to approve.
6. Write the report (format below).

## Change over time

`read_quality` gives the current state only. If the user gives you the numbers
from the last report, show the change. If not, say this report is a baseline
and suggest they keep it for next time. Never invent a previous value.

## Report format

- **Headline:** one sentence. Example: "Genesis is 62% drafted and 18%
  validated; two books need review before the March checkpoint."
- **Per project:** a short table with Drafted %, Validated %, Health, Open
  threads. Use the file names Aquilla returns.
- **Needs attention:** at most five bullets. Name the file and the reason
  (low health, open reviewer threads, nothing validated yet).
- **Waiting on people:** staged changesets and who must approve them. Include
  the approval link if `get_changeset` gives one.
- **Next steps:** at most three, each with an owner role (translator,
  consultant, project manager).

Keep it to one screen. Write for someone who does not use Aquilla every day.
Translator names are pseudonymous in Aquilla; refer to roles, not people.

## Do not

- Do not stage or change anything. This skill is read-only.
- Do not paste cell text unless the user asks for an example.
