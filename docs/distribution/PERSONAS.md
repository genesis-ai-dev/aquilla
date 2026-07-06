# Key Client Profiles / User Personas (anonymized)

> The cast the distribution cycle records footage for. Every announcement, doc, and marketing asset is framed around **one persona's money moment** — the single on-screen instant where the value becomes obvious.
>
> **Provenance & honesty:** `aquilla-specs` (the behaviour spec, source of truth) is **not checked out in this environment**, so these personas are *derived* from the in-repo evidence — `docs/design/voice-studio-market-spec.md`, the rules/terminology/back-translation/voice features in the codebase, the orgs/teams/roles model, and `docs/superpowers/specs/*onboarding*`. **Reconcile against `aquilla-specs` when accessible** (the persona slugs and money moments are the bits to verify). All names/orgs here are invented; no real client is identified.

Each persona maps to a **real app journey** (route + seeded data + steps) so a recording driver can drive the live app and capture authentic footage — see `e2e/recordings/`.

---

## P1 — The Field Translator  ·  slug `p1-field-translator`  ·  🎬 LIVE

- **Who (anonymized):** "Mara," a mother-tongue translator on a regional team, often working with intermittent connectivity. Paratext-adjacent; comfortable with source/target discipline, not with fragile software.
- **Jobs-to-be-done:** Draft and revise translation cell-by-cell against a structured source; never lose work; pick up exactly where she left off across devices and offline.
- **Value features (real, in-repo):** local-first IndexedDB outbox, automatic source segmentation on import (Markdown/USFM/DOCX), cell editor with persist-on-blur, sync when connectivity returns.
- **💡 Money moment:** *Type a translation → reload / lose signal → it's still there.* Local-first durability is the trust-builder for this audience.
- **Mapped journey:** `/projects` → create project → `Import` `sample.md` → open file → edit cell 0 → reload → text persists. (All proven page-object methods; runs today.)
- **Distribution framing:** *Announce* "Local-first translation — your work is yours, online or off." *Docs* "Importing & editing your first file." *Market* lead with the offline/durability angle. **Channels:** SIL/Paratext community, faith.tools, Bluesky/Mastodon build-in-public.

## P2 — The Translation Consultant / Reviewer  ·  slug `p2-consultant-reviewer`  ·  🎬 MARQUEE (staged)

- **Who (anonymized):** "Dr. Okoro," a consultant reviewing several teams' drafts remotely, accountable for quality and consistency across languages.
- **Jobs-to-be-done:** See a team's work live, flag issues, confirm quality, and trust that what they reviewed is what ships — without screen-shares or emailed files.
- **Value features:** real-time collaboration (y-partyserver sync), presence, health/validation rollup, comments, back-translation for review reassurance.
- **💡 Money moment:** *A translator's keystrokes appear on the consultant's screen, live* — one source of truth, no file ping-pong.
- **Mapped journey:** alice (translator) + bob (consultant) on a shared project; alice imports/edits → bob sees the file and edits propagate. (Mirrors `e2e/specs/collab/file-propagation.smoke.spec.ts` — currently `test.fixme` pending the sync-wake regression; the recording is staged and activates when that's green.)
- **Distribution framing:** *Announce* "Your whole team, one source of truth, in real time." *Market* the remote-consultant workflow. **Channels:** FBAI/translation orgs, LinkedIn (professional queries), Product Hunt (human-led).

## P3 — The Dubbing / ADR Studio Director  ·  slug `p3-voice-director`  ·  🎬 staged

- **Who (anonymized):** "Sergio," a director running a dialogue-recording session against a structured source text (Voice Studio, tier-2 picks-and-shovels per `voice-studio-market-spec.md`).
- **Jobs-to-be-done:** Get talent recording a properly-cued take fast; manage takes + director notes; track progress per character/line.
- **Value features:** cell-keyed audio takes, waveform + countdown, multi-provider TTS scratch (Gemini/Kokoro), Whisper transcription, AI consent gating; prompter/take/notes are the roadmap surface.
- **💡 Money moment:** *A new user records their first cued take in under 5 minutes, on their own content, with no manual* (the explicit onboarding bar from the market spec).
- **Mapped journey:** `/project/dev-project/voice` → load a cell → hear TTS scratch → spacebar-record a take (fake media stream in the recording config) → see it attached. (Selectors to be confirmed against the live Voice Studio UI before this spec is promoted off scaffold.)
- **Distribution framing:** *Market* "Five minutes to your first take — not five weeks of sales onboarding." **Channels:** dubbing/localization (GALA, VoiceQ-adjacent), demo-led video.

## P4 — The Academic Linguist / DH Researcher  ·  slug `p4-linguist-researcher`  ·  🎬 staged

- **Who (anonymized):** "Dr. Lindqvist," a computational/field linguist building interlinear resources and terminology sets, who values rigor, citation, and export.
- **Jobs-to-be-done:** Build/inspect interlinear word alignments, manage a terminology library, export clean data for downstream research.
- **Value features:** interlinear alignment (Dice cold-start + IBM Model 1 EM), terminology library + drill-down, statistical back-translation, export.
- **💡 Money moment:** *Source and target align word-for-word automatically*, then export the aligned data — original, citable research output.
- **Mapped journey:** project with source+target → terminology library → interlinear view → export. (Spec scaffold; alignment/export selectors to confirm.)
- **Distribution framing:** *Announce* original-data alignment report (the GEO citation magnet). **Channels:** LINGUIST List, JOSS/credibility, SBL/ACL, dev.to.

## P5 — The Program / Org Administrator  ·  slug `p5-org-admin`  ·  🎬 staged

- **Who (anonymized):** "Grace," a program lead administering many projects across teams and partner orgs, responsible for who-can-see-what.
- **Jobs-to-be-done:** Stand up orgs/teams, scope project access by role, onboard/offboard members confidently.
- **Value features:** orgs + teams, role hierarchy (viewer → contributor → reviewer → project_lead → maintainer → org-maintainer), membership lifecycle, effective-access resolution.
- **💡 Money moment:** *Add a member to a team → the right projects appear for them, with the right role* — access that's correct by construction.
- **Mapped journey:** create org → create team → attach project + member → member sees scoped projects. (Mirrors `e2e/specs/orgs/*` — the `members.smoke` flow is green; `org-access-lifecycle` covers the rest.)
- **Distribution framing:** *Docs* "Setting up your org and teams." *Market* governance/trust angle for institutional buyers. **Channels:** G2/Capterra profile, institutional outreach.

---

## Persona → journey → asset → channel matrix

| Persona | Money moment | Recording status | Primary asset | Lead channels |
|---|---|---|---|---|
| P1 Field Translator | Reload, work survives (local-first) | **LIVE** | Announce clip + onboarding doc | SIL/Paratext, faith.tools, Bluesky/Mastodon |
| P2 Consultant | Live collaboration, one source of truth | Marquee (staged on sync fix) | Hero launch video | FBAI, LinkedIn, Product Hunt |
| P3 Voice Director | First cued take < 5 min | staged | Demo-led market video | GALA, localization, demo embed |
| P4 Linguist | Auto interlinear alignment + export | staged | Original-data report | LINGUIST List, JOSS, SBL/ACL |
| P5 Org Admin | Scoped access, correct by construction | staged (members live) | Setup doc + trust page | G2/Capterra, institutional |

**Anonymization rule for the cycle:** recordings always run against seeded/synthetic data (`dev-project`, `sample.md`, invented persona names). Never record real customer projects, names, or corpora. If a real scenario is needed, reproduce it as synthetic seed first.
