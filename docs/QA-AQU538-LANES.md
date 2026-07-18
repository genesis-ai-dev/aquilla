# QA walkthrough — target-language lanes (AQU-538, slices 1–5)

**Branch:** `claude/aqu-538-project-linking-60wmeq`
**Decision doc:** `docs/superpowers/specs/2026-07-11-project-data-model-decision.md`
**Automated ground truth:** `e2e/specs/projects/add-target-language.spec.ts` (passed against a
live stack) — every click in Scenario 2 mirrors it.

---

## The UX story, honestly

**There is no "initiative" concept — the project IS the initiative.** The shipped flow is:

> create a project (ONE source language + ONE target language) → import source files →
> translate → *later*, add more target languages in **Settings → General → Languages** →
> a lane switcher appears in the editor header → translate per lane.

What you described — "start an initiative, pick source files, then choose languages to
localize into" — is the Crowdin-style mental model this data model was built FOR, but the
**creation UX doesn't offer it yet**: you cannot pick N target languages in the create
dialog. Languages are added *after* creation, one at a time, from settings. That is the
single biggest UX gap on this branch (see "UX gaps" at the bottom — the fix is small
because everything under it already works).

What DOES exist end-to-end: add-a-language, per-lane translation/validation/progress,
a create-flow steer away from sibling linked projects, a server-side merge tool for legacy
siblings, and per-member lane/file scopes.

---

## Setup

```bash
git checkout claude/aqu-538-project-linking-60wmeq
pnpm i
# local Postgres (dev stack manages the container, needs Docker running)
pnpm dev            # boots auth-worker :8788, sync-worker :8789, vite :5173
```

Log in with one click: **http://127.0.0.1:5173/__dev/login** (seeds user `dev` as OWNER of
`Dev Org` / `dev-project` and drops you in the workspace). For multi-user scenarios (S7)
use two browser profiles, or the e2e harness users.

> Fresh DB note: the dev stack loads `db/postgres/schema.sql` on first boot and reconciles
> drift (including the new PK rebuilds from migrations 0054–0056) on later boots. If your
> container predates this branch, the boot log should show "rebuilt cells PK with
> target_lang" etc. — if it doesn't, delete the `aquilla-dev-pg` container and re-run.

---

## Scenario 1 — N=1 regression (nothing changed for existing projects)

The back-compat promise: a project with one target language looks and behaves exactly as
before.

| Step | Expect |
| --- | --- |
| Create project (name, source `en`, target `fr`), import any `.md`/USFM file | Editor renders source/target as always |
| Look at the editor header | **No lane switcher anywhere** (`data-testid="lane-switcher"` absent) |
| Translate a cell, validate it, check file progress dots | Identical to main-branch behavior |
| Open Settings → General | A new **Languages** card shows "Default target language: fr" and an empty extra-lanes list — this is the only visible change at N=1 |

## Scenario 2 — the core journey: add a language, translate two lanes

| Step | Expect |
| --- | --- |
| In the project from S1 (with a French translation in cell 0): sidebar → More project options → **Settings** → **General** | **Languages** section visible (`#section-languages`) |
| Type `es` in "Add target language" (`add-target-lang-input`) → Add | `es` appears in the lanes list; duplicate/`fr`/empty entries are rejected inline |
| Back to Editor → open your file | **Lane switcher now renders** in the header, showing `fr` (the default lane label) and `es` |
| Switch to `es` | Cell 0's target is **empty** — lanes are independent; the French text is not bleeding through |
| Type Spanish in cell 0, blur to commit | Commits normally; completion/copilot now prompts with target language `es` |
| Switch back to `fr` | French text intact, no trace of the Spanish |
| Switch to `es` again | Spanish text persisted |
| Reload the page | Active lane is remembered (per-project, localStorage) |

Also worth poking: focus locks are per-lane — two windows on the SAME cell in DIFFERENT
lanes should NOT show "X is editing" to each other; same lane should.

## Scenario 3 — per-lane validation & progress

| Step | Expect |
| --- | --- |
| In lane `es`, validate cell 0 | Cell marked validated **in `es` only** |
| Switch to `fr` | Cell 0's validated state is whatever you gave it in S1 — unaffected by the `es` validation |
| Validate the same cell in `fr` too (same user) | Both lanes hold standing validations simultaneously (migration 0055's per-lane validators) |
| File progress (chapter dots / section progress) | Reflects the **default lane** on existing surfaces; per-lane rows exist server-side (`GET .../progress?lane=es`) but no UI selector yet — expected |

## Scenario 4 — lane removal is registry-only (data preserved)

| Step | Expect |
| --- | --- |
| Settings → Languages → remove `es` (confirm step) | Lane leaves the list; switcher back to hidden if only one lane remains |
| Re-add `es` | **The Spanish translations reappear** — removal never deletes lane data, it only unlists the lane |

## Scenario 5 — sibling linking is demoted (create-flow steer)

| Step | Expect |
| --- | --- |
| Dashboard → New Project → Advanced → shape **Linked target** → pick an upstream you maintain → consumes: **use its source** | A recommendation panel appears: *"Same source, new language? Add it as a target lane on ⟨upstream⟩ instead…"* with an **Add as lane** button (`add-as-lane-btn`) |
| Click Add as lane (with a target language filled in) | The UPSTREAM project gains the lane (check its Settings → Languages); **no new project is created**; dialog closes |
| Same flow but consumes: **use its translations** (the chain case) | No recommendation — the classic linked-project path is untouched |
| Below maintainer on the upstream | Button disabled, or a friendly permission message on click |

## Scenario 6 — merge a legacy sibling project (server-only, no UI yet)

Setup: two projects sharing cell ids (create the donor as a **linked target / use its
source / clone** of the host, translate a few cells in the donor), then:

```bash
JWT=<your session jwt>            # devtools → localStorage/session
HOST=<host-project-id> DONOR=<donor-project-id>
curl -s -X POST "http://127.0.0.1:8788/api/v2/projects/$HOST/merge-sibling" \
  -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d "{\"donorProjectId\":\"$DONOR\",\"lane\":\"pt\"}" | jq
```

| Check | Expect |
| --- | --- |
| Response | `{ merged: n, skipped: [...], lane: "pt", actions: ... }` — skipped lists donor cells with no matching host `cell_id` |
| Host workspace | New `pt` lane in the switcher with the donor's translations, each pinned to the host source head |
| Donor | Archived, `{ mergedInto, mergedLane }` in its settings |
| Re-run the same curl | Idempotent — no duplicate events, cell state unchanged |
| Below project_lead on either side | 403 |

## Scenario 7 — lane-scoped reviewer (AQU-553)

| Step | Expect |
| --- | --- |
| As owner: Share panel → members list → a contributor/reviewer row → **Scopes** (`member-scopes-<userId>`) | Checkbox list of lanes (+ files); save |
| Scope the member to lane `es` only | Saves; leads (500+) cannot be scoped (server rejects) |
| As that member: edit a cell in lane `es` | Works normally |
| As that member: switch to `fr` and edit | **Server rejects the write (403)** — the cell may briefly show the optimistic edit, then fail to sync (outbox dead-letters). ⚠ Known UX rough edge: the client does not yet hide or disable un-scoped lanes; see gaps below |
| Validate in `fr` as the scoped member | Also rejected |

---

## UX gaps — the make/break assessment

The plumbing is done and solid; the *narrative* has two missing beats:

1. **No "choose your languages" moment at creation** (top gap). The create dialog still
   collects exactly one target language; extra lanes are a settings afterthought. The
   Crowdin-parity move: a multi-select "Target languages" field on the self-contained
   shape — first entry = default lane, rest → `targetLanes`. Everything underneath already
   works, so this is a small, high-leverage slice.
2. **Lanes are invisible outside the editor.** Project cards/dashboard show no lane chips;
   progress surfaces default to the default lane with no per-lane breakdown UI (the
   server-side per-lane rows exist and are queryable). An "Overview: per-lane completion"
   column is the natural follow-up (it also gives Wendi-style oversight its surface).
3. **Scoped-user feedback is server-truth-only.** A lane-scoped user can still SELECT a
   forbidden lane and type; rejection arrives as a failed sync rather than a disabled
   control. The client should grey out un-scoped lanes in the switcher (scopes are already
   on the sync token, so the client can read them).
4. **The merge tool has no UI** (deliberate deferral) — QA it via curl as above.

Recommended order if you agree the UX story is the crux: **1 → 3 → 2 → 4.**
