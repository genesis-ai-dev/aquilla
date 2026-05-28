# Voice Studio — Market Spec & Integration Plan

Concise spec for Aquilla's Voice Studio as a "picks-and-shovels" product in the
dubbing / ADR / dialogue-localization space. Defines the market, where features
land, the onboarding bar, the workhorse feature set, and how we integrate them
better than incumbents.

---

## 1. The market, in three tiers

Dubbing/voice localization splits cleanly into three tiers. Mixing them up is
the most common mistake in pitch decks. We live in tier 2.

| Tier | What it is | Buyers | Examples |
|---|---|---|---|
| 1. Generative AI dubbing | Upload media → AI translates + clones voice + outputs dubbed file | Creators, marketers, indie YouTubers, enterprise L&D | ElevenLabs Dubbing Studio, HeyGen, Rask, Dubbing AI, Synthesia |
| **2. Professional ADR / dialogue-production software (picks-and-shovels)** | **Tooling that human studios use to record, cue, sync and manage scripted dialogue against picture or against source text** | **Studios, post houses, translation orgs, vendor networks** | **VoiceQ, Mosaic (Noblurway), Cappella (Phonations), ZOOdubs, Synchronos, Sounds in Sync (EdiCue / EdiPrompt), Joker — and Aquilla's Voice Studio** |
| 3. Managed dubbing-as-a-service | A vendor owns the whole pipeline | Streamers, studios outsourcing localization | Iyuno, ZOO Digital, Deluxe, Keywords |

Aquilla is tier 2, with an unusual angle: most tier-2 tools sync dialogue to
**picture**; we sync dialogue to **a source text segmentation** (cells /
verses / passages). That is the same workflow plumbing, applied to a different
medium. The picks-and-shovels engineering is identical: ingest a script,
segment it, attach takes to segments, manage talent + director notes, ship a
deliverable.

## 2. Where features land in tier 2

The tier-2 feature set is well-defined. Every serious incumbent ships a
variant of these. Grouped by job-to-be-done:

### A. Script & adaptation
- Script ingestion (formatted: Final Draft, Word, USX/USFM, srt, plain text)
- Translation/adaptation workspace, with side-by-side source/target
- Lip-sync / length constraint helpers (syllable count, character ceiling, timing budget)
- Versioning of the adapted script (so a director's edits don't clobber a translator's)

### B. Cueing & sync
- Time-coded segmentation (against picture for film/TV, against source-text or source-audio for our case)
- Rythmo-band display (scrolling text under picture) — the defining tier-2 UI
- Beep/streamer/visual cue method (the Hollywood alternative — Sounds in Sync's territory)
- Auto-detection of speaker change / line breaks

### C. Recording session
- Take management (multiple takes per line, mark "circle take")
- Loop record / punch-in
- Director notes per take
- Talent prompter view (clean, large text, the line + ~1s of lead-in)
- DAW integration (Pro Tools is the industry default; integration via OMF/AAF or direct control)

### D. Project & talent management
- Per-actor / per-character line lists
- Session scheduling, call sheets, billable line counts
- Progress dashboards (lines recorded vs. total, per episode, per actor)
- Multi-language project structure (one source, many target language projects)

### E. Collaboration & delivery
- Remote sessions (director on one continent, talent on another)
- Asset hand-off (mixed stems, per-line WAVs, metadata sidecars)
- Approval workflow (translator → director → QC → final)
- Audit trail (who changed what, when)

### F. AI augmentation (the 2024–2026 frontier)
- AI rough adaptation / lip-sync word timing (VoiceQ 6.0's Writer feature)
- AI voice synthesis as a scratch track or final
- Voice cloning of original talent (consent-gated)
- Automatic transcription of source audio (Whisper-class)
- Automatic alignment of recorded take to script

## 3. Where Aquilla's Voice Studio is today

From the codebase: cell-keyed audio model (each text segment can hold takes),
recording with waveform + countdown, peaks/eager-peaks cache, multi-provider
TTS (Gemini, Kokoro on-device), MMS, Whisper transcription, voice cloning,
play-queue, AI consent gating. The spine — **segment → take(s) → metadata**
— is already the same spine the tier-2 incumbents are built on.

Mapping our current state to the feature taxonomy above:

| Section | Have | Partial | Missing |
|---|---|---|---|
| A. Script & adaptation | Source text per cell | Side-by-side translation workspace exists elsewhere in app | Adaptation constraints (length/syllable), version pinning of adaptation |
| B. Cueing & sync | Cell-level segmentation | — | Rythmo-band scroll UI, beep-cue mode, source-audio-driven cueing |
| C. Recording session | Single-take record, waveform, countdown | — | Multi-take + "circle take", loop record / punch-in, director notes per take, prompter view |
| D. Project & talent mgmt | Per-cell audio bookkeeping | — | Talent/character entities, session structure, progress dashboard, billable line counts |
| E. Collaboration & delivery | Cloud sync of audio takes | Approval state at cell level | Multi-role workflow, exportable session packages (WAV+sidecar), audit trail |
| F. AI augmentation | TTS (Gemini/Kokoro), MMS, Whisper, voice clone | AI scratch take per cell | AI alignment of recorded take to script, AI adaptation suggestions, on-device timing assist (VoiceQ Writer equivalent) |

Read across: we have ~40% of the tier-2 surface area, with **all the
hard-to-build infrastructure already in place**: the segment model, the
take/attachment model, the sync layer, the AI providers. What's missing is
mostly **UI for studio-grade workflows** and **a few session-shaped data
entities** (talent, take, director-note).

## 4. The killer onboarding bar

Tier-2 tools have terrible onboarding. They are sold to studios via demos and
sales reps, so the first-run UX is usually a wall of buttons. This is the
single biggest opening for us.

Killer onboarding for this category means: **a new user records their first
properly-cued take in under 5 minutes, on their own content, with no manual.**
Concretely:

1. **Bring-your-own content in one step.** Drop a script (text, USFM, srt,
   Final Draft, Word) — or paste a passage. We segment it automatically and
   show it ready-to-record. No project-wizard maze.
2. **Hear the goal before you record.** Auto-generate a TTS scratch take for
   the first line, in a voice close to the target. The user hears the target
   before they're asked to perform.
3. **One-key record loop.** Spacebar starts, spacebar punches out, enter
   advances. Prompter view large enough to read from across a desk. The whole
   loop should feel like a teleprompter, not a DAW.
4. **Instant feedback on the take.** Waveform + auto-aligned overlay against
   the source timing, with a "circle this take" affordance. No save dialogs.
5. **Show progress immediately.** "3 / 412 lines done." A progress bar is the
   single most motivating UI element in this category — VoiceQ's reporting
   panels exist because studios are paid by the line.
6. **Invite a collaborator before asking for payment.** Director-mode link
   sharing on day one. This is how the product earns multi-seat revenue.

Anti-patterns to avoid (every incumbent does at least one of these):
- Forcing project creation before the user has tried recording.
- Requiring DAW setup as a precondition.
- Hiding the rythmo-band / prompter behind a settings panel.
- Asking the user to define talent/character entities up front.

## 5. The workhorse features — ranked by daily-use leverage

Of the tier-2 surface, these are the features that get used every single
minute of a session. Ship these to professional quality and the product is
sticky; everything else is gravy.

1. **Prompter + rythmo-band scroll.** This *is* the product to the talent in
   the booth. Has to be fast, large, legible, with adjustable lead-in and
   line-context.
2. **One-key take loop with multiple takes per line + "circle take".**
   Director never opens a menu. Spacebar / shortcut driven.
3. **Director notes per take.** Free-text, tagged ("warmer", "faster",
   "again"), timestamped. Becomes the trail the mix engineer follows.
4. **Per-character / per-actor line list with progress.** The session
   organizing principle. Filterable, sortable, exportable.
5. **Auto-alignment of recorded take to script timing.** Whisper-class
   alignment so the take drops into the right place automatically. Removes
   the tedious manual nudge step.
6. **Export package.** Per-line WAVs + JSON sidecar + EDL/AAF for the mix
   engineer. The deliverable studios actually invoice on.
7. **AI scratch take.** TTS in target voice as a reference + a fallback for
   pickups. Already largely shipped — needs to be present at the right place
   in the workflow.

Everything else (rythmo-band authoring UI, complex billing, full DAW control)
is a follow-on once these seven feel inevitable.

## 6. Integration plan — how we ship it, better

Phased so each phase is shippable on its own.

### Phase 1 — Make the booth experience inevitable (1–2 weeks)
- Prompter mode for the existing recording flow: large text, lead-in line,
  spacebar punch-in/out, enter to advance.
- Multiple takes per cell (data model is mostly there — surface "takes" as
  first-class) + "circle take" affordance.
- Director notes attached to each take.
- Progress strip: "n / total lines recorded" with per-character breakdown.

### Phase 2 — Make the director experience inevitable (2–3 weeks)
- Talent/character entity (light — name, voice ref, lines assigned).
- Session view: line list filtered by character, progress per character,
  jump-to-line.
- Director-mode share link (read + comment, no edit). One-click invite.
- Approval state per take (pending / circled / approved / rejected).

### Phase 3 — Make the deliverable inevitable (1–2 weeks)
- Export bundle: per-line WAVs, JSON sidecar with timing + notes + take
  metadata, optional zip.
- Audit trail per cell (already partial via sync — surface it).

### Phase 4 — AI assist where it earns its keep (ongoing)
- Auto-align recorded take to source-text timing using Whisper (already in
  repo). Eliminates manual nudge.
- AI adaptation suggestions in the script panel (length-constrained
  rewrite) — picks up where TTS scratch ends.
- On-device timing assist analogous to VoiceQ Writer, using Kokoro/MMS.

### Phase 5 — The differentiator (later)
- Source-text-driven rythmo-band: dialogue scrolls in sync with **source
  audio** (where present) rather than picture. Nobody in tier 2 ships this
  natively because nobody else has the source-text-aligned data model we do.
- Multi-language project pivot (same segmentation, swap target language) —
  trivial for us, hard for picture-based incumbents.

## 7. What we deliberately do *not* build

- Full DAW. Pro Tools wins. We export to it.
- Tier-1 fully-autonomous AI dubbing. ElevenLabs/HeyGen win that. We use
  TTS as a *scratch* and *assist*, not as the deliverable.
- Tier-3 managed service. We sell tools, not labor.

## 8. One-sentence positioning

> Aquilla Voice Studio is the picks-and-shovels recording, cueing, and
> delivery platform for human dubbing and dialogue-recording teams working
> against a structured source text — built on the same spine as VoiceQ and
> Mosaic, with onboarding that meets a creator in five minutes instead of a
> sales rep in five weeks.
