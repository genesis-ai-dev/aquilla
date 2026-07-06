# Promo creative process — persona-targeted trailers via sub-agents

A promo trailer is only as good as the **emotion it lands in one specific
person**. "Populated projects the moment you land" is a *feature*, not a
reason to care. A project manager cares about hitting deadlines without the
chaos; a field translator cares that the words they prayed over are never
lost. Same product, opposite films.

So the trailer pipeline separates **creativity** from **rendering**:

```
persona (PERSONAS.md)
   + product truth
   + emotional doctrine        ─▶  creative-director SUB-AGENT  ─▶  brief JSON
                                                                     │
 scripts/promo/briefs/<persona>.brief.json  ◀────────────────────────┘
                                                                     │
                                       npm run promo -- --persona X  ▼
                              real app stills + compose.html + synth ─▶ trailer.mp4
```

The **brief** (`scripts/promo/types.ts → PromoBrief`) is the unit of
creativity and the only thing that changes between two personas' trailers:
the emotional throughline, the five scenes' copy, the musical `mood`, and the
beat grid. Everything downstream (composition, audio, ffmpeg) is a pure
function of the brief.

## The sub-agent step

For each target persona, spawn a **creative-director sub-agent** (Claude Code
`Agent` tool, or any LLM) with three inputs:

1. **The product truth** — what literally happens on screen (so claims stay
   honest and the real footage can carry the proof).
2. **The persona** — from `PERSONAS.md`: their world, their money moment.
3. **The emotional doctrine** — the feeling arc to evoke *without stating it*.
   This is the craft. Examples that worked:
   - **Manager (p5-org-admin):** empowerment + relief. The turn is *"the
     tools changed"* — it was never that they were bad at the job; the ground
     shifted. Land on confident control. Mood `build`.
   - **Field translator (p1-field-translator):** safety + trust. Their fear is
     losing work; the turn is *"then it just stays."* Reassurance, not blame.
     Land warm. Mood `intimate`.

The sub-agent returns a strict `PromoBrief` JSON (5 scenes:
`cold-open → reveal → showcase → proof → cta`, ~10 beats with one `impact` at
the CTA) plus a short rationale. Validate, then save to
`scripts/promo/briefs/<persona>.brief.json`.

> Why sub-agents and not one prompt: each runs in its own context with a single
> persona's psychology to inhabit, so the voice stays distinct and the manager's
> film doesn't bleed into the translator's. Fan out one per persona; compare
> rationales; keep the briefs that ring true. The two starter briefs in
> `scripts/promo/briefs/` were authored exactly this way.

## Writing a brief well (the rules of the room)

- **Don't sell the feature — land the feeling.** Footage proves the feature;
  the words carry the emotion. Keep `showcase`/`proof` copy spare so the real
  app footage does the work.
- **No blame.** Reframe old pain as "the tools made you carry it that way."
  Relief converts to trust and trust converts to trial.
- **Concrete beats abstract.** "Who's on chapter 9?" > "Manage your projects."
- **Title ≤ ~28 chars, subtitle ≤ ~50.** It renders huge; long lines die.
- **CTA** title = `Aquilla`, subtitle = a short identity-level tagline
  ("Lead the work. Not the chaos." / "Your words, always kept.").
- **Mood** picks the score's character (`build` | `intimate` | `epic`).

## Render it

```bash
npm run promo:capture                      # real app stills (once; reused across personas)
npm run promo -- --persona p5-org-admin    # manager cut
npm run promo -- --persona p1-field-translator   # translator cut
```

Outputs: `aquilla-<persona>.mp4` (16:9) + `aquilla-<persona>-9x16.mp4` +
`<persona>.score.wav`. Route every cut through the human gate before
publishing (see DISTRIBUTION-CYCLE.md).

## Adding a persona

1. Confirm the persona + money moment in `PERSONAS.md`.
2. Spawn a creative-director sub-agent with the three inputs above.
3. Save the returned JSON to `scripts/promo/briefs/<slug>.brief.json`.
4. `npm run promo -- --persona <slug>` and watch the cut; iterate the brief
   (copy/timing/mood) — never the renderer — until it lands.
