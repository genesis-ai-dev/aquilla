# Linked Projects swarm — TRACES

Gaps, deferrals, and honest limitations discovered during the swarm. Append-only.

- 2026-07-06 · start · none yet.
- 2026-07-06 · QA finding (pre-existing, out of swarm scope): the editor has NO source-edit affordance — QA had to emit source.cell.commit via raw POST /events. Upstream template editing UX is a gap for the Come and See workflow (template owners fix English lines). Candidate follow-up issue.
- 2026-07-06 · QA cosmetic: ProjectCreateDialog upstream picker shows raw project UUID after selection (fixer may address if trivial).
- 2026-07-06 · AQU-477 QA step 8 (violet→amber flip after middle-hop revalidates) not exercised live — covered by unit tests only.
- 2026-07-06 · QA environment: concurrent session's e2e harness force-killed the QA dev stack mid-run (:5173 contention); QA re-ran on isolated ports 6173/9788/9789. Findings unaffected.
