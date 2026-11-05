# 0006 — The event log's head compare-and-swap

*Decided 2026 (AD-2, AQU-1154, audit RACE-2); recorded 2026-11-05 (AQU-2387).
Summary of the rule: `CLAUDE.md`.*

## Context

The source of truth is an append-only event log; the `cells` / `files` tables
are a projection of it. Two contributors can edit the same cell while one of
them is offline, and both events arrive eventually. Something has to decide
which one is the cell's current text — without losing the other, and without
the answer depending on which replica replayed the log.

CRDTs and OT were both considered and rejected: a translation cell is prose a
person owns, not a buffer two people type into, and "both edits merged into one
paragraph" is a worse outcome than "yours is still here, theirs won".

## Decision

Every write is an event carrying a `parent_id`: the prior winning event on the
same `(project, file, cell)`. A chain-mutating event projects **only if its
parent is still the row's head** — a compare-and-swap against
`cells.event_id`. A stale sibling is logged (history keeps it), answered `200`,
and reported back in the response's `stale[]` array so the client can say so.

Two mechanisms, both inside the same transaction as the event insert
(`sync-worker/src/events/event-insert.ts`):

- **First-child arbitration** through the `chain_claims` table —
  `sync-worker/src/events/chain-claims.ts::buildChainClaimStmt` emits an
  `INSERT … ON CONFLICT DO NOTHING` before the projection statements, and every
  chain-advancing write is gated on that claim existing for *this* event. The
  transaction that loses the claim still logs its event; its projection writes
  are no-ops. Genesis events (no parent) use the sentinel
  `sync-worker/src/events/chain-claims.ts::GENESIS_PARENT_KEY`, because unique
  indexes treat NULLs as distinct.
- **The head CAS itself** (AQU-1154), because the claim alone is
  *first-child-of-parent*, which let a stale branch climb back onto the head
  through an unclaimed slot. The route reads the write's row count back — `0`
  means it lost.

The per-project sequence counter row lock serializes same-project
transactions, so the claim winner is always the lowest-`server_seq` sibling —
which is exactly the tie-break the replay in `sync-worker/src/events/rebuild.ts`
uses. **Replay and live agree by construction**, and that is the property worth
protecting.

## Consequences

- A losing write is never an error. Clients must handle a `200` with a
  non-empty `stale[]`, and the UI's job is to tell the human, not to retry
  blindly.
- Any new chain-mutating event kind has to take the claim *and* the head CAS.
  One without the other reintroduces a race that only shows up as replay
  disagreeing with the live projection — the hardest class of bug here.
- Rebuilding a projection (`/admin/projects/:id/rebuild-projection`) is a
  legitimate repair precisely because replay is deterministic.
- Offline divergence resolves by the parent chain, so an offline editor's work
  is kept in history even when it does not become the head.

## Not covered yet

- There is no merge UI: the loser's text lives in the cell's history and a
  human reconciles it by hand.
- The rule covers `(project, file, cell)` chains. Project- and file-level
  settings writes are last-write-wins and are not claimed.
