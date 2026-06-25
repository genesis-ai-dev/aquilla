# Multimedia / Timeline-Organized Files — Design

**Status:** Draft for discussion · 2026-06-24
**Driver:** Come and See (The Chosen) dubbing + subtitling workflow; Wendi / Anna
**Builds on:** the existing "Timeline-segment-model (Scope A)" already in the cell schema

---

## 1. The problem we're solving

Come and See currently runs **two separate projects per episode** for the same video:

1. a **dialogue / audio** project — cells timed for *recording* (full spoken sentences), and
2. a **subtitle** project — cells timed for *reading* (split, condensed text).

These exist as two projects because:

- The two are **timed differently** and **split differently**. A line of dialogue is one
  recorded utterance; the same line on screen may be split across several subtitle cues (and
  condensed — "go get the man with the purple robe and the ring" as audio becomes "go get that
  man" as a subtitle).
- They have **different sources**. The subtitle source text and the dialogue source text are
  not the same string, so each needs its own source column — and therefore its own dependent
  target column.

Anna maintains per-episode **Python scripts** that split subtitles apart and re-join them for
recording. That glue is exactly what we want to absorb into the app.

The core realization: subtitles and audio/dialogue are **not** a parent-child pair where one
owns the other's timing. They are **independent, overlapping tracks on a shared timeline** —
the timeline of the underlying video/audio. Once we model them that way, one project replaces
two.

---

## 2. Core concept: a file whose spine is a timeline

A **multimedia (timeline-organized) file** is a file whose primary ordering is the **timeline
of a core media object** — a video (uploaded, or a link we stream) or an audio clip used as the
backbone — rather than a linear sequence of text cells.

> The current order key already supports this: files carry an `orderedBy` lens
> (`sequence` vs `timeline`), and cells carry `startMs`/`endMs` plus a fractional
> `sequenceIndex`, so a cell can sit at a time position *and* be inserted between two others
> without renumbering.

On top of that spine sit **multiple independent tracks** (rows). Each track holds **cards**
(cells). Cards can **overlap in time** across and within tracks, because their timestamps are
independent.

### Track types (extensible)

The set of rows is **not fixed** — it must be extensible so we can add new kinds of content
later (gif/video/image overlays, notes, etc.) without a schema change. The metadata bucket on
each cell already allows this. The initial rows for Come and See:

| Row | Holds | Source/target |
|---|---|---|
| **Untimed dumping ground** | Cards that have **no timestamp**, kept in their own array order | Default home for anything not yet placed on the timeline |
| **Subtitle track** | Subtitle cards, timed for reading | **Subtitle source** + dependent **subtitle target** |
| **Dialogue / audio track** | Dialogue cards (Wendi's "audio"), timed for recording | **Dialogue source** + dependent **dialogue/audio target** |
| **Core media spine** | The video/audio timeline itself | The clip provides the source audio content |
| *(future rows)* | Notes, image/gif overlays, additional languages… | Extensible |

The whiteboard sketch (attached to the issue) shows exactly this: a dumping-ground row, a "add
more rows/tracks — should be extensible" affordance, a subtitle row, an audio/dialogue row, the
horizontal timeline arrow for the core file, and a source/target detail pair underneath.

---

## 3. The two views

The same file is editable through two lenses (we already have a Text | Audio/Media toggle that
preserves scroll + selection across the switch).

### 3a. Text-based view (translation-first)

For translators who think in text. Shows:

- **subtitle source** → **subtitle target** (the translation of the subtitle), and
- optionally **audio attached to a subtitle** as a *dependent* clip — i.e. the model we have
  today, where an audio take hangs off a text cell.

This view is the comfortable, cell-by-cell editing surface. It deliberately does **not** force
the translator to reason about overlapping timelines.

### 3b. Multimedia view (horizontal timeline editor)

For the work that the text view can't express: overlapping, independently-timed tracks.

Imagine a standard audio/video editor:

- A **horizontal timeline** of the core media file, scrollable left↔right.
- **Stacked track lanes**: the media spine on top (with a **video preview** above the timeline
  or in a small preview pane), then speaker/dialogue source cards, then subtitle source cards,
  then their respective target cards — each lane independent.
- **Speakers identified at points in the audio** — the source audio file itself provides the
  source content; users mark up / create **source cards** for each speaker at the right time
  positions.
- **Variable granularity / zoom** — zoom the timeline in and out and navigate the way you would
  in any DAW or video editor.
- Cards can be **moved, stretched, and overlapped** without affecting other lanes.

**Clicking a card** populates a **small cell editor at the bottom** of the main editor area —
the same row-detail surface we use on non-multimedia files. From there you can edit the card's
text, edit/attach its audio, change voices, set camera state, etc.

```
┌───────────────────────────────────────────────────────────────────────┐
│  [ video preview ]                                                      │
├───────────────────────────────────────────────────────────────────────┤
│  Untimed dumping ground:  [card] [card] [card] …  (array order)         │
├───────────────────────────────────────────────────────────────────────┤
│  Subtitle track   ░░[sub]░░  ░[sub]░  ░░░[sub]░░░          → scroll →   │
│  Dialogue track   ░░░░[dialogue (one utterance)]░░░░                    │
│  ──────────────────  core media timeline  ───────────────────────────▶ │
├───────────────────────────────────────────────────────────────────────┤
│  Selected card detail:   [ source ]            [ target ]               │
│                          (audio edit · change voice · camera state …)   │
└───────────────────────────────────────────────────────────────────────┘
```

---

## 4. Source/target & overlap rules

- **Target always depends on its source.** In translation the target card is derived from a
  source card; that dependency is unchanged.
- **There can be more than one source lane.** Specifically a **dialogue source** *and* a
  **subtitle source**, which is the whole reason two projects exist today. Therefore:
  - dialogue-source cards → dependent **audio/dialogue target** cards, and
  - subtitle-source cards → dependent **subtitle target** cards.
- **Sources may overlap in time** — both with each other (a dialogue line spanning several
  subtitle cues) and within a lane. The multimedia view must render and allow overlapping
  ranges; the text view collapses to the non-overlapping subtitle+target case.
- **Camera state stays a first-class, separate attribute** (`on | mixed | off`) on media cards,
  driving lip-sync constraints — it is *not* folded into the speaker/voice label.

---

## 5. What already exists vs. what's new

**Already in place (Scope A foundation):**

- File-level `orderedBy` lens (`sequence` | `timeline`).
- Cell fields: `startMs`/`endMs`, fractional `sequenceIndex`, `medium: text | media`,
  `transcription`, `cameraState`, and an extensible `metadata` JSONB bucket.
- Text | Audio/**Media** editor-mode toggle (relabels when the file is time-ordered).
- Cast/voice assignment per cell (independent of camera state); VTT export round-trips speaker
  identity via `<v Name>` tags.

**New work this design implies:**

1. **Multiple, overlapping source lanes** in one file (dialogue source + subtitle source), each
   with its dependent target lane — the model change that collapses two projects into one.
2. **Horizontal multi-track timeline editor** (scroll, zoom/granularity, overlap, drag/stretch,
   video preview, click-to-detail bottom pane).
3. **Untimed dumping-ground lane** for cards without timestamps, in array order.
4. **Extensible track definitions** so new row types don't need a schema change.
5. **Media streaming optimization** for uploaded video (stream down efficiently as the user
   scrubs) — a real performance workstream, not an afterthought.
6. **Migration/ingest**: absorb Anna's split/re-join Python step (subtitles split for reading,
   re-joined for recording) into import, so one project carries both timings.
7. **ASR + speaker diarization ingest** — turn an added media file into timed,
   speaker-segmented source cards (editable by the user).
8. **AI-assisted source-cleanup loop** — RAG over already-corrected segments + an agent regex
   pass over the rest, to clean ASR output.
9. **Clone-vs-live source link** — a per-project setting for how a downstream project consumes a
   template's source (snapshot copy vs. live subscription).
10. **Template / linked-project management UI** — including a **graphical view** of which projects
    are linked to a given template, and whether each link is clone or live.

---

## 6. End-to-end authoring / ingest pipeline

A timeline project can be seeded from either modality; both converge on a set of timed,
speaker-segmented **source** lanes that downstream language projects build on.

### Entry points (either works; add the other later)

- **Start with subtitles** (timestamped text) — already segmented and timed → becomes the
  **subtitle-source** lane.
- **Start with media** (audio or video) — no text yet → run **ASR + speaker diarization** to
  produce timed, speaker-tagged segments → becomes the **dialogue-source** lane.
- Adding the other modality later yields *both* source lanes — the dialogue-source +
  subtitle-source split that forces two projects today, now in one.

### The source pipeline (audio → clean source → translation)

Raw audio is the source of truth. ASR is a *machine draft* of the transcription; human + AI
cleanup produces the **clean source transcript**. Cleanup is **source-side** — it writes back
into the source transcription (the existing `transcription` cell field), it does **not** create a
separate translation target. The genuine target is the next step down.

```
raw audio → ASR (machine draft) → human + AI cleanup → CLEAN SOURCE
                                                          → translation (source → target)
                                                              → target text → optional target audio
```

This deliberately mirrors the existing translate surface (source → MT → human edit), so the same
prediction/validation tooling is reused for transcription cleanup — only the input modality is new.

### AI-assisted cleanup loop

Two complementary mechanisms, both few-shot from the user's *own* corrections:

- **RAG over already-cleaned segments** — predict fixes for the remaining segments from how the
  user corrected earlier ones (idiosyncratic, context-dependent fixes).
- **Agent regex pass** — for *systematic* ASR errors (a name consistently mistranscribed), apply a
  regex across the un-cleaned segments.

The user can always adjust ASR/diarization output: split/merge a segment, reassign a speaker,
edit text.

### One-time work, reused downstream

Most of this ingest (ASR, diarization, source cleanup, cast setup, camera-state tagging) is
**one-time work on a template/master project**. Downstream language projects then consume that
source content; each downstream project chooses, per project, **how** it consumes it — see §7,
clone vs. live.

---

## 7. Open questions

- **One file or sibling files?** Do dialogue and subtitle live as separate lanes *within one
  file*, or as sibling files sharing one timeline spine? (Leaning: lanes within one file, so the
  spine is unambiguous.)
- **Granularity authority** — when a dialogue card maps to N subtitle cards, is that mapping
  stored, or purely positional via overlapping time ranges?
- **Default view per role** — do translators land in text view and producers/Anna in timeline
  view?
- **Video source** — uploaded file vs. linked stream: what's the storage/streaming contract,
  and how do we keep scrubbing responsive?
- **Export** — how do the two target lanes export (subtitle VTT vs. recording script), now that
  they're one project?
- **Clone vs. live source — a per-project checkbox, not a fork.** When a downstream project is
  created from a template, the creator picks **Clone** (snapshot copy of the source at creation)
  or **Dynamic / live source** (subscribe to the template's source cells; an upstream fix
  flags/propagates to dependents). Both are supported; it's a setting. Live mode is the "shared
  upstream source cells" idea from the meeting.
- **No management UI yet.** There is no surface for managing templates / live links. We want to
  **graphically represent** the relationships — a view of all projects linked to a given
  (template) project, showing which edges are clone vs. live.

---

## 8. Why this matters

No existing tool we've found combines a CAT/TMS translation surface with a video-editor
timeline. Getting this right collapses Come and See's two-project + Python-glue workflow into a
single project, removes a whole class of manual steps, and gives us a differentiated capability
for any dubbing + subtitling partner.
