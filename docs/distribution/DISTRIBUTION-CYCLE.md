# The Distribution Cycle — announce · document · market, with real recordings

> The repeatable loop that turns a shipped (or existing) feature into persona-targeted announcement, documentation, and marketing assets — built on **authentic footage of the live app**, framed around one **client persona's money moment**. This is the operational layer under `DISTRIBUTION-ORCHESTRATION.md` (the strategy) and `PERSONAS.md` (the cast).

## Principle

Every asset answers: **"Whose problem does this solve, and what's the one moment that proves it?"** We don't record feature tours; we record a persona hitting their money moment in the real product. The same flow our e2e suite asserts is the flow we film — so marketing can't drift from reality.

## The loop

```
  1. TRIGGER            a feature merges (FRO-###) — or we pick an existing feature to re-tell
        │
        ▼
  2. MAP TO PERSONA     PERSONAS.md → which persona's money moment does this serve?
        │               (code AND distribution are equal — shipping isn't done until this runs)
        ▼
  3. RECORD (real)      npm run record -g "<persona>"  → live app, captions/chapters burned in,
        │                                                <slug>.webm + <slug>.storyboard.json
        ▼
  4. ASSEMBLE           npm run record:assemble  → clean MP4, edit-list, per-channel cuts, optional VO
        │               → HyperFrames/Remotion adds branded title cards + intro/outro (deterministic)
        ▼
  5. WRITE              announce post + docs page + landing/market copy, drafted from the storyboard
        │               (one Opus editor enforces a single brand voice)
        ▼
  6. HUMAN GATE         taste + brand + claims check; anything outward-facing is Tier-2/3 (see below)
        │
        ▼
  7. SCHEDULE           Postiz → green-tier channels auto; human-led for PH/HN/community
        │
        ▼
  8. MEASURE            PostHog activation by source · Search Console · AI-citation share
        └──────────────▶ feeds the next trigger (demand-pulled, not repo-pushed)
```

## What's built in this repo

| Stage | Artifact |
|---|---|
| Personas + journeys | `docs/distribution/PERSONAS.md` |
| Recording harness | `e2e/config/playwright.config.recordings.ts`, `e2e/recordings/helpers/showcase.ts`, `e2e/recordings/specs/*.showcase.ts` |
| Run commands | `npm run record`, `npm run record:assemble` (boot via `scripts/e2e-up.ts`, `E2E_CONFIG` override) |
| Assembly | `scripts/assemble-showcase.ts` (transcode + edit-list + cuts + optional ElevenLabs VO) |
| Orchestration | `.claude/skills/distribution-cycle/SKILL.md` |
| Strategy / channels | `docs/distribution/DISTRIBUTION-ORCHESTRATION.md` |

## Recording status (honest)

- **P1 Field Translator — LIVE.** Built on the proven import-and-edit + persistence flow; `npm run record -- -g "P1"` produces real footage today.
- **P2 Consultant (marquee), P3 Voice Director, P4 Linguist, P5 Org Admin — staged.** Specs/scaffolds exist; P2 is `test.fixme` because its underlying collaboration journey is itself `fixme` (sync-wake regression). **We never record a broken flow** — each lights up the moment its journey is green, which is also the moment it's worth announcing.

## The human gate (blast-radius tiered)

Same tiering as the Build pipeline, stricter outward-facing:
- **Autonomous:** recording, assembly, draft generation, storyboard/edit-list.
- **Human-approve before publish:** the published video, docs page, landing copy, social schedule.
- **Human-led (agent assists only):** Product Hunt / Show HN / Reddit / community posts, and any claim of a result. A take that asserts a value moment that didn't actually render on screen is a release blocker, not a polish item.

## Cadence

- **Per feature ship:** P-aligned announce clip + docs embed (via `/ship`).
- **Weekly:** one persona re-tell of an existing feature (rotate personas) → blog + social.
- **Per release / launch moment:** marquee persona hero video (human-gated, may use generative b-roll).
- **Monthly:** an original-data artifact for the linguist persona (the GEO citation magnet).

## Run the cycle now

```bash
npm run record -- -g "P1"      # capture the live P1 take
npm run record:assemble        # → e2e/recordings/output/p1-...mp4 + editlist.json + cuts
# then: HyperFrames/Remotion title cards → human gate → Postiz
```
