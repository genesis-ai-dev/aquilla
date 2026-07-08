# Agent-complete workbench — chat spine, live cards, and the commitment tiers

Status: DESIGN + first slice IMPLEMENTED on `main` (2026-07-08). Extends
2026-07-02-agent-mode-v2-design.md; changes none of its safety rails.

## 1. Thesis

Every capability in Aquilla is an event, and the agent already stages events
for human apply. Therefore "agent-complete" — every app capability reachable
from the agent surface — is a **rendering problem, not a rewrite**: each event
kind / tool result gets a purpose-built inline card, and every card's actions
flow through the same staged-apply outbox path the working set uses today.

The transition story (the Cursor arc: IDE → agentic, old chrome recedes) falls
out for free: the dock, the workbench, and the classic UI all write through
one event path and share one session store. Two front doors, one house. The
acceptance ledger generalizes into the transition metric: per capability, how
much flows through the agent surface vs. the old chrome.

## 2. Chat is the spine, not the container

Heavyweight interactive surfaces scrolling *inside* messages die when the next
message arrives (scroll-away mid-review, height competition, staleness — see
the stale-read blanking fix, 26f9c55c). So:

- **Spine**: every action/result lands in the timeline as a compact, LIVE
  card. Cards are handles, not snapshots — counters and text re-derive from
  projections/decisions (receipt pattern), never freeze what a tool saw.
- **Stage**: when a card needs room (working set, editor, comment thread) it
  expands into a stage area summoned BY the timeline, one at a time, and
  collapses back into its card. The workbench's fixed "rail | grid" split is
  the degenerate case; long-term the grid is just the stage the draft-review
  card summons.

Two standing rules (existing feedback, restated):
- Cards are **directly interactive** — clicking acts immediately, never
  "ask the agent to do it" round-trips.
- Cards **re-derive from truth** — user decisions out-rank tool sightings
  (deriveWorkingSet final pass); reads refresh, they don't regress.

## 3. Commitment tiers — the agent prepares, the human commits

Validation is not an edit; it is **testimony** ("I, with this role, assert
this is right"). An agent cannot testify. Tier every event kind:

| Tier | Kinds | Apply rule |
|---|---|---|
| 1. Drafts & notes | `target.cell.commit`, `comment.create` | one-click apply; accept-all allowed; per-user auto-apply MAY exist someday |
| 2. Testimony | `cell.validate`, `cell.unvalidate`, endorsements | **per-item human click, always.** No accept-all, no auto-apply, regardless of any future toggle — bulk one-click validation hollows out N-of-M semantics |
| 3. Structural | `file.delete`, member/role changes | human click + the agent does not stage these in v1 |

The tier is a property of the KIND, enforced in the card layer (and the server
role gates behind it stay authoritative as ever).

## 4. Card registry

`src/components/agent/cards/registry.tsx` maps timeline content → card:

- `toolCardFor(item)` — a ToolItem with typed `data` gets a rich card under
  its chip (e.g. `data.cells` → PassageCard). Null → chip only.
- `proposalCardFor(proposal)` — proposal composition picks the surface:
  all-`target.cell.commit` → working-set/receipt (existing), all-
  `cell.validate` → ValidationQueueCard, else the generic ProposalCard.

New capability = one card + (usually) zero new plumbing. The registry is the
checklist that makes "agent-complete" enumerable: passages ✓, drafts ✓,
validation ✓, comments (next), flags/health (next), history, assignments.

## 5. PassageCard — display + in-card navigation + activity surfacing

The card renders what the tool was asked to show (aligned source/target rows,
side toggle Source | Target | Both) — AND the user can navigate to a different
chapter *inside the card* (client-side `fetchFileCells`, no agent round-trip,
no tokens).

**Navigation is context the model must hear about.** Card interactions queue
**activity notes** on the session store (`noteActivity(key, note)`, coalesced
by key so only the latest navigation per card survives). The next send drains
them into the WIRE message only:

```
<user text>

[user activity since your last reply]
- In the MRK 4 passage view, the user navigated to MRK 5 (target side).
```

This reuses the existing wire/display split (context-chip legend pattern):
the bubble shows what the user typed; the model additionally learns what the
user did. Notes clear on send and on session reset.

## 6. ValidationQueueCard — tier 2 made concrete

Staged `cell.validate` proposals render as a queue: each row shows ref + the
target text under validation (`display.before`) with ONE Confirm button per
row. Each click applies exactly that event through the outbox with the user's
token. There is deliberately no "validate all". j/k + Enter keyboard flow can
come later — per-item deliberateness stays.

## 7. Sequencing

1. ✅ This slice: registry + PassageCard (+ activity notes) + ValidationQueueCard.
2. Comments card (event kind already stages + applies; needs a card).
3. Flags/health card; history card.
4. Stage mechanics: cards summon/dismiss the singleton stage panel; the
   workbench grid becomes the draft-card's stage.
5. Old-chrome recession, measured by the per-capability ledger.
