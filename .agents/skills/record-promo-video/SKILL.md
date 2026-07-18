---
name: record-promo-video
description: Build a persona-targeted PROMO trailer (hype/launch reel) — fast cuts, kinetic type, synced score, in 16:9 and 9:16 — combining the Hormozi hook framework with REAL walkthrough footage from doc-mode recordings, via the deterministic scripts/promo pipeline. Use when asked to "make a promo / trailer / launch video", "hype reel", "social cut", "sizzle", or to produce marketing video for a persona. For a clarity-first how-to use record-docs-video; for the full announce+docs+market loop use distribution-cycle.
---

# Record a promo trailer

Produces a persona-targeted trailer that combines **emotional storytelling** (Hormozi 4-step: Pain → Dream → Fix → CTA) with **real app footage** — not just Ken-Burns over stills. Output: a 16:9 master + a 9:16 social reformat. Full harness docs: `e2e/recordings/README.md` (Promo section). Creative method: `docs/distribution/PROMO-CREATIVE-PROCESS.md`. Umbrella loop: the `distribution-cycle` skill.

---

## The key insight: promo = hook + walkthrough clips + CTA

The old approach (Ken-Burns over static screenshots) produces trailers that look slick but feel hollow — the viewer never sees the app actually working. The fix: **interleave real walkthrough clips** from doc-mode recordings into the promo's Hormozi structure.

### Hormozi 4-Step framework (adapted for app promos)

| Step | Duration | What it does | Footage source |
|------|----------|-------------|----------------|
| **1. Pain** (0–5s) | 3–5s | Agitate the exact problem. Specific relatable scenario, not abstract pain. No intro. | Kinetic type + emotional audio. No app footage yet — this is pure hook. |
| **2. Dream** (5–10s) | 3–5s | Flip it. Show what life looks like if the problem is gone. | Brief flash of the app's money moment (from a doc recording's climax clip). The viewer glimpses the answer before understanding how. |
| **3. Fix** (10–35s) | 15–25s | Show the mechanism. Why this solves it. NOT features — the logic. | **This is where walkthrough clips live.** 2–4 real doc-recording clips showing the app solving the problem step by step. Each clip 3–8s, intercut with kinetic type naming the benefit. |
| **4. CTA** (35–45s) | 5–10s | One action, frictionless. Identity-level tagline. | Branded lockup + tagline. |

**Hook is 80% of the ad.** If they don't feel the pain in 3 seconds, the rest doesn't matter.

### Footage hierarchy (what makes a promo convincing)

1. **Best: real walkthrough clips** — extracted from doc-mode `.webm` recordings. The app is actually being used. Cursor moves, cells fill, indicators update. This IS proof.
2. **Good: real stills with Ken-Burns** — captured from `promo:capture`. Static but authentic.
3. **Fallback: stylized panel** — the composition's fallback when no footage exists. Ships something but lacks proof.

Always push for (1). Fall back to (2) only for features without a doc recording yet. Never ship (3) if you can avoid it.

---

## Quick start

```sh
# 1. Ensure doc recordings exist for the features you want to show
#    (see record-docs-video skill for how to produce these)
ls e2e/recordings/output/*.mp4   # check what walkthrough clips are available

# 2. Capture real hero stills from the live app (boots the stack; reused across personas)
WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgresql://aquilla:***@127.0.0.1:5432/aquilla_dev \
  npm run promo:capture

# 3. Build a persona's trailer
npm run promo -- --persona p5-org-admin        # the manager's cut
npm run promo -- --persona p1-field-translator # the translator's cut
npm run promo:all                              # capture, then build default persona
```

## How it works (`scripts/promo/`)
1. `e2e/recordings/specs/promo-capture.showcase.ts` drives the real curated app (marketing login + `@showcase` labels) → hero stills in `output/promo/app/`. Real footage, not mockups.
2. `compose.html` — a self-contained composition exposing `window.__seek(t)`: background, framed device panel (Ken-Burns crossfade of the stills), kinetic type, heartbeat pulse, CTA lockup. Everything derives from `t` (no rAF/CSS-transition state).
3. `render.ts` loads it headless and seek-and-shoots every frame (`__seek(frame/fps)` → screenshot).
4. `synth-audio.ts` code-synthesizes the score (heartbeat + pad + riser + impact) as PCM/WAV — rights-clean, beat-aligned.
5. `build.ts` muxes frames + audio with ffmpeg into the 16:9 master + 9:16 reformat.

`promo.config.ts` is the single source of truth for duration/fps/scenes/beats — edit a number, re-run `npm run promo`.

## Using doc-recording clips in promos

Doc-mode recordings (from `record-docs-video`) contain the most compelling proof footage. To use them:

### Extracting clips from doc recordings

Each doc recording has a storyboard JSON with chapter timestamps. Extract the best moments:

```bash
# Find the money moment timestamp from a doc recording's storyboard
jq '.events[] | select(.type == "chapter") | {text, timestamp}' \
  e2e/recordings/output/<doc-slug>.storyboard.json

# Extract a 5-second clip around the money moment
ffmpeg -ss <start> -t 5 -i e2e/recordings/output/<doc-slug>.mp4 \
  -c:v libx264 -an -y output/promo/clips/<clip-name>.mp4
```

### Which doc clips work best in promos

- **Money moments** (3–5s): the payoff beat from a doc recording. Self-contained, emotionally clear. Use in the "Dream" or "Fix" step.
- **Interaction proof** (3–8s): a specific click→result sequence that proves a claim. Use in the "Fix" step.
- **Before/after** (5–8s): two clips showing the problem state then the solved state. Use across "Pain" and "Fix."

### What does NOT work as a promo clip

- Long exposition sequences — if it needs context from earlier in the doc video, it's too complex for a promo cut.
- Static UI with no interaction — this is what stills already do; clips must show MOVEMENT.
- Text-heavy screens — unreadable at promo speed. Prefer moments where visual state changes (colors, indicators, animations).

## Authoring a new persona cut

Only the **brief** changes between cuts; the renderer is shared. Each persona's emotion differs (manager: "Lead the work. Not the chaos." vs translator: "Your words, always kept.").

1. Confirm/add the persona in `docs/distribution/PERSONAS.md`.
2. Author `scripts/promo/briefs/<slug>.brief.json` — throughline, five scenes' copy, musical `mood`, beats, and now also **clip references** (which doc recordings to pull proof footage from). Briefs are written via the sub-agent creative process in `PROMO-CREATIVE-PROCESS.md` (existing: `p1-field-translator`, `p5-org-admin`).
3. `npm run promo -- --persona <slug>` and review.

### Brief structure (extended for clip integration)

The brief JSON should include a `clips` array in the `fix` scene that maps claims to proof footage:

```json
{
  "scenes": {
    "cold-open": { "title": "Pain hook", "subtitle": "Specific relatable scenario" },
    "reveal": { "title": "Dream state", "subtitle": "What life looks like solved" },
    "showcase": {
      "title": "How it works",
      "subtitle": "The mechanism",
      "clips": [
        {
          "source": "editor-translate-cell-doc",
          "chapter": "Cell editing",
          "duration": 5,
          "caption": "Type a translation. It just stays."
        },
        {
          "source": "validation-validate-cell-doc",
          "chapter": "Validation",
          "duration": 4,
          "caption": "Quality checks run automatically."
        }
      ]
    },
    "proof": { "title": "Social proof or stat", "subtitle": "Credibility" },
    "cta": { "title": "Aquilla", "subtitle": "Your tagline here" }
  }
}
```

### Creative direction (from the Hormozi framework)

- **Hook must be a specific relatable scenario**, not abstract pain. "Rent's due. Last invoice: 3 weeks ago." beats "Time tracking is hard."
- **Privacy as hero (not footnote):** if on-device privacy is a feature, lead with it as the product superpower. "Your phone went to every job. The question is: who gets to use that data?"
- **Never reuse App Store preview for social** — 73% of marketers who did saw lower CTR. Separate assets for separate funnels.
- **Don't sell the feature — land the feeling.** The walkthrough clips prove the feature; the kinetic type carries the emotion.
- **No blame.** Reframe old pain as "the tools made you carry it that way."
- **Concrete beats abstract.** "Who's on chapter 9?" > "Manage your projects."
- **Title ≤ ~28 chars, subtitle ≤ ~50.** Renders huge; long lines die.

### Audio for promos

- **Synth score** (default): `synth-audio.ts` generates a rights-clean score (heartbeat + pad + riser + impact). Mood options: `build` | `intimate` | `epic`.
- **Suno** (optional): for a more polished feel, generate a track with Suno. Prompt for instrumental only (no lyrics). Pick the best 60s window from the generated track: `ffmpeg -i track.mp3 -t 62 -af "afade=t=out:st=58:d=4" promo-cut.mp3`. Mux after render.

## Gotchas
- `promo:capture` uses `scripts/e2e-up.ts` + the live app, so the same boot rules as recordings apply: export `WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` (→ running `aquilla-dev-pg`) or auth-worker won't boot; the app authenticates via `/__marketing/login`.
- If no app stills exist yet, `compose.html` falls back to a stylized panel so the pipeline always produces something — but ship real stills.
- Don't `git push` while capturing (pre-push smoke fights for the ports). Output is git-ignored.
- **85% of mobile video is watched muted** — always have text overlay / kinetic type carrying the story. Audio is a bonus, not the primary channel.
- **First 3 seconds = 80% of effectiveness** — the pain hook must land immediately.

## Platform format reference

| Platform | Aspect | Length | Sound | Style |
|----------|--------|--------|-------|-------|
| LinkedIn | 16:9 | 30–45s | Optional | Problem → narrative → demo |
| YouTube Shorts | 9:16 | ≤60s | Expected | Hook + problem + solution |
| TikTok/Reels | 9:16 | 15–60s | Expected | Hook-first, fast cuts |
| App Store | 9:16 | 15–30s | Muted | UI-forward, no hook needed |
| YouTube (long) | 16:9 | 60–120s | Expected | Full Hormozi framework |

**Never post YouTube links to LinkedIn** — 40% engagement penalty. Upload native video.

## Rules
- Real footage + rights-clean synth audio only. Anonymize: seeded data, invented names.
- Publishing/scheduling is human-gated (outward-facing) — hand the master to the human gate, don't post it.
- **Proof over polish.** A promo with real walkthrough clips showing the app working beats a beautiful motion-graphics trailer with no product footage. The walkthrough IS the differentiator.
