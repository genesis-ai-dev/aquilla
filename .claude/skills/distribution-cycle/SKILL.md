---
name: distribution-cycle
description: Produce persona-targeted announcement, documentation, and marketing assets for a new or existing feature, built on REAL recordings of the live app. Use when shipping a feature and you want to announce/document/market it, when asked to "make a demo video", "record a showcase", "do the launch assets", "tell the story of feature X", or to run the distribution cycle. Drives the real app per a client persona's money moment, assembles cuts, and stages them behind the human gate.
---

# Distribution cycle

Turn a feature into announce/document/market assets framed around one client persona's **money moment**, with authentic footage of the live app. Full design: `docs/distribution/DISTRIBUTION-CYCLE.md`. Cast: `docs/distribution/PERSONAS.md`. Strategy/channels: `docs/distribution/DISTRIBUTION-ORCHESTRATION.md`.

## When to use
- A feature merged (an `FRO-###`) and "done" includes telling its story.
- The user wants a demo/showcase video, launch assets, docs walkthrough, or to re-tell an existing feature.
- Asked to "run the distribution cycle" / "ship the announcement".

## When NOT to use
- Pure internal refactors with no user-facing value moment.
- A flow that's currently broken (`test.fixme`): stage the take, don't record it. A take is only shippable if the value moment actually renders.

## The loop

1. **Map to a persona.** Read `PERSONAS.md`. Pick the persona whose money moment this feature serves; if none fits, propose a new persona row (reconcile against `aquilla-specs` when available) and get human sign-off.
2. **Ensure a showcase spec.** Reuse/extend `e2e/recordings/specs/<persona>.showcase.ts`. Drive the persona's mapped journey with existing **page objects** + **multi-user fixtures**, wrapped in the `Showcase` helper (`chapter`/`caption`/`beat`/`save`). **Assert the value moment** (`expect`). If the journey is `fixme` in the e2e suite, mark the showcase `fixme` and stop — report the blocking issue instead.
3. **Record the real app.** `npm run record -- -g "<persona>"`. Confirm `e2e/recordings/output/<slug>.webm` + `<slug>.storyboard.json` were produced. If the stack won't boot or the take fails, debug it — do not hand back a broken/empty recording as done (`verify-dev-change` discipline).
4. **Assemble.** `npm run record:assemble` (add `--vo` for ElevenLabs narration). Produces the MP4, edit-list, and per-channel cuts (announce/docs/market). Feed the edit-list to the HyperFrames/Remotion composition for branded title cards + intro/outro.
5. **Write.** Draft the announce post, docs page, and landing copy from the storyboard — one consistent brand voice. Keep claims to what the footage actually shows.
6. **Human gate, then schedule.** Surface the video + copy for taste/brand/claims approval (Tier-2). Route community/PH/HN posts to the human (Tier-3). On approval, schedule green-tier channels via Postiz.
7. **Record state.** Append what shipped + where to `docs/distribution/` state and the `Distribution` Linear project; note measurement to check (PostHog activation by source, Search Console, AI-citation share).

## Hard rules
- **Real footage only** — drive the live app; never fabricate screens. Anonymize: seeded/synthetic data only, invented persona names, never real customer corpora.
- **Don't record broken flows** — stage as `fixme` until the journey is green.
- **Outward-facing actions are human-gated** — the published asset, the schedule, and all community posts.
- Keep this skill and its specs thin; the value is the persona→money-moment discipline, not volume.
