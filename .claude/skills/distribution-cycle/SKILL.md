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

2. **Plan content coverage FIRST.** Before recording anything, enumerate the features this video must demonstrate. Use `docs/FEATURE-STORIES.csv` (filter by Area) and `docs/FEATURE-VIDEOS-PLAN.md` as the checklist. Write a shot list — the `record-docs-video` skill has the template and the discipline. **This is where most videos fail:** skipping the planning step and winging the storyboard.

3. **Record the doc walkthrough (clarity-first).** Use `record-docs-video` to produce a comprehensive how-to video. This is the PROOF footage — it shows every feature actually working, with the cursor leading the eye and captions narrating. The shot list from step 2 is your completeness check. **Don't ship a doc video that skips listed features.**

4. **Build the promo trailer (emotion-first).** Use `record-promo-video` to produce a persona-targeted trailer. The key improvement: **the promo now pulls real walkthrough clips from the doc recording** (step 3), not just static screenshots. This means the promo trailer shows the app IN MOTION — actual clicks, transitions, state changes — intercut with Hormozi-framework kinetic type (Pain → Dream → Fix → CTA). The doc recording is the proof; the promo is the emotion.

5. **Write.** Draft the announce post, docs page, and landing copy from the storyboard — one consistent brand voice. Keep claims to what the footage actually shows.

6. **Human gate, then schedule.** Surface the video + copy for taste/brand/claims approval (Tier-2). Route community/PH/HN posts to the human (Tier-3). On approval, schedule green-tier channels via Postiz.

7. **Record state.** Append what shipped + where to `docs/distribution/` state and the `Distribution` Linear project; note measurement to check (PostHog activation by source, Search Console, AI-citation share).

### One recording → multiple assets

A single doc-mode recording session produces:
- **Doc video** (full walkthrough, 30–60s) → docs site, YouTube tutorial
- **Promo clips** (3–8s money moments extracted from the doc recording) → promo trailer's "Fix" section
- **Stills** (key frames from the recording) → social posts, landing page
- **Storyboard JSON** (chapter timestamps + captions) → VO script, blog post outline

## Hard rules
- **Real footage only** — drive the live app; never fabricate screens. Anonymize: seeded/synthetic data only, invented persona names, never real customer corpora.
- **Don't record broken flows** — stage as `fixme` until the journey is green.
- **Outward-facing actions are human-gated** — the published asset, the schedule, and all community posts.
- Keep this skill and its specs thin; the value is the persona→money-moment discipline, not volume.
